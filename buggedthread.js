const moment = require("moment");
const Eris = require("eris");

const bot = require("../bot");
const knex = require("../knex");
const utils = require("../utils");
const config = require("../cfg");
const attachments = require("./attachments");
const { formatters } = require("../formatters");
const { callBeforeNewMessageReceivedHooks } = require("../hooks/beforeNewMessageReceived");
const { callAfterNewMessageReceivedHooks } = require("../hooks/afterNewMessageReceived");
const { callAfterThreadCloseHooks } = require("../hooks/afterThreadClose");
const { callAfterThreadCloseScheduledHooks } = require("../hooks/afterThreadCloseScheduled");
const { callAfterThreadCloseScheduleCanceledHooks } = require("../hooks/afterThreadCloseScheduleCanceled");
const snippets = require("./snippets");
const { getModeratorThreadDisplayRoleName } = require("./displayRoles");

const ThreadMessage = require("./ThreadMessage");

const {THREAD_MESSAGE_TYPE, THREAD_STATUS, DISCORD_MESSAGE_ACTIVITY_TYPES} = require("./constants");
const {isBlocked} = require("./blocked");
const {messageContentToAdvancedMessageContent} = require("../utils");

const escapeFormattingRegex = new RegExp("[_`~*|]", "g");

/**
 * @property {String} id
 * @property {Number} thread_number
 * @property {Number} status
 * @property {String} user_id
 * @property {String} user_name
 * @property {String} channel_id
 * @property {Number} next_message_number
 * @property {String} scheduled_close_at
 * @property {String} scheduled_close_id
 * @property {String} scheduled_close_name
 * @property {Number} scheduled_close_silent
 * @property {String} alert_ids
 * @property {String} log_storage_type
 * @property {Object} log_storage_data
 * @property {String} created_at
 * @property {String} metadata
 */
class Thread {
  constructor(props) {
    utils.setDataModelProps(this, props);

    if (props.log_storage_data) {
      if (typeof props.log_storage_data === "string") {
        this.log_storage_data = JSON.parse(props.log_storage_data);
      }
    }

    if (props.metadata) {
      if (typeof props.metadata === "string") {
        this.metadata = JSON.parse(props.metadata);
      }
    }
  }

  getSQLProps() {
    return Object.entries(this).reduce((obj, [key, value]) => {
      if (typeof value === "function") return obj;
      if (typeof value === "object" && value != null) {
        obj[key] = JSON.stringify(value);
      } else {
        obj[key] = value;
      }
      return obj;
    }, {});
  }

  /**
   * @param {Eris.MessageContent} text
   * @param {Eris.MessageFile|Eris.MessageFile[]} file
   * @returns {Promise<Eris.Message>}
   * @throws Error
   * @private
   */
  async _sendDMToUser(content, file = null) {
    // Try to open a DM channel with the user
    const dmChannel = await this.getDMChannel();
    if (! dmChannel) {
      throw new Error("Could not open DMs with the user. They may have blocked the bot or set their privacy settings higher.");
    }

    return dmChannel.createMessage(content, file);
  }

  /**
   * @param {Eris.MessageContent} content
   * @param {Eris.MessageFile} file
   * @return {Promise<Eris.Message|null>}
   * @private
   */
  async _postToThreadChannel(content, file = null) {
    try {
      let firstMessage;

      const textContent = typeof content === "string" ? content : content.content;
      const contentObj = typeof content === "string" ? {} : content;
      if (textContent) {
        // Text content is included, chunk it and send it as individual messages.
        // Files (attachments) are only sent with the last message.
        const chunks = utils.chunkMessageLines(textContent);
        for (const [i, chunk] of chunks.entries()) {
          // Only send embeds, files, etc. with the last message
          const msg = (i === chunks.length - 1)
            ? await bot.createMessage(this.channel_id, { ...contentObj, content: chunk }, file)
            : await bot.createMessage(this.channel_id, { ...contentObj, content: chunk, embed: null });

          firstMessage = firstMessage || msg;
        }
      } else {
        // No text content, send as one message
        firstMessage = await bot.createMessage(this.channel_id, content, file);
      }

      return firstMessage;
    } catch (e) {
      // Channel not found
      if (e.code === 10003) {
        console.log(`[INFO] Failed to send message to thread channel for ${this.user_name} because the channel no longer exists. Auto-closing the thread.`);
        this.close(true);
      } else if (e.code === 240000) {
        console.log(`[INFO] Failed to send message to thread channel for ${this.user_name} because the message contains a link blocked by the harmful links filter`);
        await bot.createMessage(this.channel_id, "Failed to send message to thread channel because the message contains a link blocked by the harmful links filter");
      } else {
        throw e;
      }
    }
  }

  /**
   * @param {Object} data
   * @returns {Promise<ThreadMessage>}
   * @private
   */
  async _addThreadMessageToDB(data) {
    if (data.message_type === THREAD_MESSAGE_TYPE.TO_USER) {
      data.message_number = await this._getAndIncrementNextMessageNumber();
    }

    const dmChannel = await this.getDMChannel();
    const insertedIds = await knex("thread_messages").insert({
      thread_id: this.id,
      created_at: moment.utc().format("YYYY-MM-DD HH:mm:ss"),
      is_anonymous: 0,
      dm_channel_id: dmChannel.id,
      ...data
    });

    const threadMessage = await knex("thread_messages")
      .where("id", insertedIds[0])
      .select();

    return new ThreadMessage(threadMessage[0]);
  }

  /**
   * @param {number} id
   * @param {object} data
   * @returns {Promise<void>}
   * @private
   */
  async _updateThreadMessage(id, data) {
    await knex("thread_messages")
      .where("id", id)
      .update(data);
  }

  /**
   * @param {number} id
   * @returns {Promise<void>}
   * @private
   */
  async _deleteThreadMessage(id) {
    await knex("thread_messages")
      .where("id", id)
      .delete();
  }

  /**
   * @returns {Promise<Number>}
   * @private
   */
  async _getAndIncrementNextMessageNumber() {
    return knex.transaction(async trx => {
      const nextNumberRow = await trx("threads")
        .where("id", this.id)
        .select("next_message_number")
        .first();
      const nextNumber = nextNumberRow.next_message_number;

      await trx("threads")
        .where("id", this.id)
        .update({ next_message_number: nextNumber + 1 });

      return nextNumber;
    });
  }

  /**
   * Adds the specified moderator to the thread's alert list after config.autoAlertDelay
   * @param {string} modId
   * @returns {Promise<void>}
   * @private
   */
  async _startAutoAlertTimer(modId) {
    clearTimeout(this._autoAlertTimeout);
    const autoAlertDelay = utils.convertDelayStringToMS(config.autoAlertDelay);
    this._autoAlertTimeout = setTimeout(() => {
      if (this.status !== THREAD_STATUS.OPEN) return;
      this.addAlert(modId);
    }, autoAlertDelay);
  }

  /**
   * @param {Eris.Member} moderator
   * @param {string} text
   * @param {Eris.MessageFile[]} replyAttachments
   * @param {boolean} isAnonymous
   * @param {Eris.MessageReference|null} messageReference
   * @returns {Promise<boolean>} Whether we were able to send the reply
   */
  async replyToUser(moderator, text, replyAttachments = [], isAnonymous = false, messageReference = null, components = []) {
    const regularName = config.useDisplaynames
      ? moderator.user.globalName || moderator.user.username
      : moderator.user.username;
    let moderatorName =
      config.useNicknames && moderator.nick ? moderator.nick : regularName;
    if (config.breakFormattingForNames) {
      moderatorName = moderatorName.replace(escapeFormattingRegex, "\\$&");
    }
  
    const roleName = await getModeratorThreadDisplayRoleName(moderator, this.id);
    /** @var {Eris.MessageReference|null} userMessageReference */
    let userMessageReference = null;
  
    // Handle replies
    if (config.relayInlineReplies && messageReference) {
      const repliedTo = await this.getThreadMessageForMessageId(
        messageReference.messageID
      );
      if (repliedTo) {
        userMessageReference = {
          channelID: repliedTo.dm_channel_id,
          messageID: repliedTo.dm_message_id,
        };
      }
    }
  
    if (config.allowSnippets && config.allowInlineSnippets) {
      // Replace {{snippet}} with the corresponding snippet
      // The beginning and end of the variable - {{ and }} - can be changed with the config options
      // config.inlineSnippetStart and config.inlineSnippetEnd
      const allSnippets = await snippets.all();
      const snippetMap = allSnippets.reduce((_map, snippet) => {
        _map[snippet.trigger.toLowerCase()] = snippet;
        return _map;
      }, {});
  
      const inlineSnippetRegex = new RegExp(
        `${escapeRegex(config.inlineSnippetStart)}([\\w-]+)${escapeRegex(
          config.inlineSnippetEnd
        )}`,
        "g"
      );
  
      text = text.replace(inlineSnippetRegex, (match, trigger) => {
        const snippet = snippetMap[trigger.toLowerCase()];
        return snippet ? snippet.body : match;
      });
    }
  
    const formattedAttachments = replyAttachments.map((a) => ({
      filename: a.filename,
      file: a.url,
    }));
  
    let formatted = text;
    if (!isAnonymous) {
      formatted = config.showStaffRoles
        ? `${roleName} **${moderatorName}**: ${text}`
        : `**${moderatorName}**: ${text}`;
    }
  
    if (config.formatStaffName) {
      formatted = config.formatStaffName(moderatorName, roleName, text);
    }
  
    const messageOptions = {
      content: formatted,
      files: formattedAttachments,
      message_reference:
        userMessageReference ||
        (messageReference
          ? {
              message_id: messageReference.messageID,
              channel_id: messageReference.channelID,
              guild_id: messageReference.guildID,
            }
          : undefined),
      components: components, // <--- Include components in messageOptions
    };
  
    try {
      const dmChannel = await this.getDMChannel();
      const sentDmMessage = await bot.createMessage(dmChannel.id, messageOptions);
      await this.saveReply(moderator.id, text, isAnonymous, sentDmMessage.id);
      return true;
    } catch (e) {
      console.error("Error sending reply to user:", e);
      await this.postSystemMessage(`Failed to send reply to user: ${e.message}`);
      return false;
    }
  }
  

    // Prepare attachments, if any
    const files = [];
    const attachmentLinks = [];

    if (replyAttachments.length > 0) {
      for (const attachment of replyAttachments) {
        await Promise.all([
          attachments.attachmentToDiscordFileObject(attachment).then(file => {
            files.push(file);
          }),
          attachments.saveAttachment(attachment).then(result => {
            attachmentLinks.push(result.url);
          })
        ]);
      }
    }

    const rawThreadMessage = new ThreadMessage({
      message_type: THREAD_MESSAGE_TYPE.TO_USER,
      user_id: moderator.id,
      user_name: moderatorName,
      body: text,
      is_anonymous: (isAnonymous ? 1 : 0),
      role_name: roleName,
      attachments: attachmentLinks,
    });
    const threadMessage = await this._addThreadMessageToDB(rawThreadMessage.getSQLProps());

    const dmContent = messageContentToAdvancedMessageContent(await formatters.formatStaffReplyDM(threadMessage));
    if (userMessageReference) {
      dmContent.messageReference = {
        ...userMessageReference,
        failIfNotExists: false,
      };
    }

    const inboxContent = messageContentToAdvancedMessageContent(await formatters.formatStaffReplyThreadMessage(threadMessage));
    if (messageReference) {
      inboxContent.messageReference = {
        channelID: messageReference.channelID,
        messageID: messageReference.messageID,
        failIfNotExists: false,
      };
    }

    // Because moderator replies have to be editable, we enforce them to fit within 1 message
    if (! utils.messageContentIsWithinMaxLength(dmContent) || ! utils.messageContentIsWithinMaxLength(inboxContent)) {
      await this._deleteThreadMessage(threadMessage.id);
      await this.postSystemMessage("Reply is too long! Make sure your reply is under 2000 characters total, moderator name in the reply included.");
      return false;
    }

    // Send the reply DM
    let dmMessage;
    try {
      dmMessage = await this._sendDMToUser(dmContent, files);
    } catch (e) {
      await this._deleteThreadMessage(threadMessage.id);
      await this.postSystemMessage(`Error while replying to user: ${e.message}`);
      return false;
    }

    // Special case: "original" attachments
    if (config.attachmentStorage === "original") {
      threadMessage.attachments = dmMessage.attachments.map(att => att.url);
    }

    threadMessage.dm_message_id = dmMessage.id;
    await this._updateThreadMessage(threadMessage.id, threadMessage.getSQLProps());

    // Show the reply in the inbox thread
    const inboxMessage = await this._postToThreadChannel(inboxContent, files);
    if (inboxMessage) {
      threadMessage.inbox_message_id = inboxMessage.id;
      await this._updateThreadMessage(threadMessage.id, { inbox_message_id: inboxMessage.id });
    }

    // Interrupt scheduled closing, if in progress
    if (this.scheduled_close_at) {
      await this.cancelScheduledClose();
      await this.postSystemMessage("Cancelling scheduled closing of this thread due to new reply");
    }

    // If enabled, set up a reply alert for the moderator after a slight delay
    if (config.autoAlert) {
      this._startAutoAlertTimer(moderator.id);
    }

    return true;
  }

  /**
   * @param {Eris.Message} msg
   * @returns {Promise<void>}
   */
  
  async receiveUserReply(msg, skipAlert = false) {
    const user = msg.author;
    const opts = {
      thread: this,
      message: msg,
    };
    let hookResult;

    // Call any registered beforeNewMessageReceivedHooks
    hookResult = await callBeforeNewMessageReceivedHooks({
      user,
      opts,
      message: opts.message
    });
    if (hookResult.cancelled) return;

    let messageContent = msg.content || "";

    // Prepare attachments
    const attachmentLinks = [];
    const smallAttachmentLinks = [];
    const attachmentFiles = [];

    for (const attachment of msg.attachments) {
      const savedAttachment = await attachments.saveAttachment(attachment);

      // Forward small attachments (<2MB) as attachments, link to larger ones
      if (config.relaySmallAttachmentsAsAttachments && attachment.size <= config.smallAttachmentLimit) {
        const file = await attachments.attachmentToDiscordFileObject(attachment);
        attachmentFiles.push(file);
        smallAttachmentLinks.push(savedAttachment.url);
      }

      attachmentLinks.push(savedAttachment.url);
    }

    // Handle inline replies
    /** @var {Eris.MessageReference|null} messageReference */
    let messageReference = null;
    if (config.relayInlineReplies && msg.referencedMessage) {
      const repliedTo = await this.getThreadMessageForMessageId(msg.referencedMessage.id);
      if (repliedTo) {
        messageReference = {
          channelID: this.channel_id,
          messageID: repliedTo.inbox_message_id,
        };
      }
    }

    // Handle special embeds (listening party invites etc.)
    if (msg.activity) {
      let applicationName = msg.application && msg.application.name;

      if (! applicationName && msg.activity.party_id.startsWith("spotify:")) {
        applicationName = "Spotify";
      }

      if (! applicationName) {
        applicationName = "Unknown Application";
      }

      let activityText;
      if (msg.activity.type === DISCORD_MESSAGE_ACTIVITY_TYPES.JOIN || msg.activity.type === DISCORD_MESSAGE_ACTIVITY_TYPES.JOIN_REQUEST) {
        activityText = "join a game";
      } else if (msg.activity.type === DISCORD_MESSAGE_ACTIVITY_TYPES.SPECTATE) {
        activityText = "spectate";
      } else if (msg.activity.type === DISCORD_MESSAGE_ACTIVITY_TYPES.LISTEN) {
        activityText = "listen along";
      } else {
        activityText = "do something";
      }

      messageContent += `\n\n*<This message contains an invite to ${activityText} on ${applicationName}>*`;
      messageContent = messageContent.trim();
    }

    if (msg.stickerItems && msg.stickerItems.length) {
      const stickerLines = msg.stickerItems.map(sticker => {
        return `*Sent sticker "${sticker.name}":* https://media.discordapp.net/stickers/${sticker.id}.webp?size=160`
      })

      messageContent += "\n\n" + stickerLines.join("\n");
    }

    messageContent = messageContent.trim();

    // Save DB entry
    let threadMessage = new ThreadMessage({
      message_type: THREAD_MESSAGE_TYPE.FROM_USER,
      user_id: this.user_id,
      user_name: config.useDisplaynames ? msg.author.globalName || msg.author.username : msg.author.username,
      body: messageContent,
      is_anonymous: 0,
      dm_message_id: msg.id,
      dm_channel_id: msg.channel.id,
      attachments: attachmentLinks,
      small_attachments: smallAttachmentLinks,
    });

    threadMessage = await this._addThreadMessageToDB(threadMessage.getSQLProps());

    // Show user reply in the inbox thread
    const inboxContent = messageContentToAdvancedMessageContent(await formatters.formatUserReplyThreadMessage(threadMessage));
    if (messageReference) {
      inboxContent.messageReference = {
        channelID: messageReference.channelID,
        messageID: messageReference.messageID,
        failIfNotExists: false,
      };
    }
    const inboxMessage = await this._postToThreadChannel(inboxContent, attachmentFiles);
    if (inboxMessage) {
      await this._updateThreadMessage(threadMessage.id, { inbox_message_id: inboxMessage.id });
    }

    if (config.reactOnSeen) {
      await msg.addReaction(config.reactOnSeenEmoji).catch(utils.noop);
    }

    // Call any registered afterNewMessageReceivedHooks
    await callAfterNewMessageReceivedHooks({
      user,
      opts,
      message: opts.message
    });

    // Interrupt scheduled closing, if in progress
    if (this.scheduled_close_at) {
      await this.cancelScheduledClose();
      await this.postSystemMessage(`<@!${this.scheduled_close_id}> Thread that was scheduled to be closed got a new reply. Cancelling.`, {
        allowedMentions: {
          users: [this.scheduled_close_id],
        },
      });
    }

    if (this.alert_ids && ! skipAlert) {
      const ids = this.alert_ids.split(",");
      const mentionsStr = ids.map(id => `<@!${id}> `).join("");

      await this.deleteAlerts();
      await this.postSystemMessage(`${mentionsStr}New message from ${this.user_name}`, {
        allowedMentions: {
          users: ids,
        },
      });
    }
  }

  /**
   * @returns {Promise<PrivateChannel>}
   */
  getDMChannel() {
    return bot.getDMChannel(this.user_id);
  }

  /**
   * @param {string} text
   * @param {object} opts
   * @param {object} [opts.allowedMentions] Allowed mentions for the thread channel message
   * @param {boolean} [opts.allowedMentions.everyone]
   * @param {boolean|string[]} [opts.allowedMentions.roles]
   * @param {boolean|string[]} [opts.allowedMentions.users]
   * @param {Eris.MessageReference} [opts.messageReference]
   * @returns {Promise<void>}
   */
  async postSystemMessage(text, opts = {}) {
    const threadMessage = new ThreadMessage({
      message_type: THREAD_MESSAGE_TYPE.SYSTEM,
      user_id: null,
      user_name: "",
      body: text,
      is_anonymous: 0,
    });

    const content = messageContentToAdvancedMessageContent(await formatters.formatSystemThreadMessage(threadMessage));
    content.allowedMentions = opts.allowedMentions;
    if (opts.messageReference) {
      content.messageReference = {
        ...opts.messageReference,
        failIfNotExists: false,
      };
    }
    const msg = await this._postToThreadChannel(content);

    threadMessage.inbox_message_id = msg.id;
    const finalThreadMessage = await this._addThreadMessageToDB(threadMessage.getSQLProps());

    return {
      message: msg,
      threadMessage: finalThreadMessage,
    };
  }

  /**
   * @param {string} text
   * @returns {Promise<ThreadMessage>}
   */
  async addSystemMessageToLogs(text) {
    const threadMessage = new ThreadMessage({
      message_type: THREAD_MESSAGE_TYPE.SYSTEM,
      user_id: null,
      user_name: "",
      body: text,
      is_anonymous: 0,
    });
    return this._addThreadMessageToDB(threadMessage.getSQLProps());
  }

  /**
   * @param {string} text
   * @param {object} opts
   * @param {object} [allowedMentions] Allowed mentions for the thread channel message
   * @param {boolean} [allowedMentions.everyone]
   * @param {boolean|string[]} [allowedMentions.roles]
   * @param {boolean|string[]} [allowedMentions.users]
   * @param {boolean} [allowedMentions.postToThreadChannel]
   * @returns {Promise<void>}
   */
  async sendSystemMessageToUser(text, opts = {}) {
    const threadMessage = new ThreadMessage({
      message_type: THREAD_MESSAGE_TYPE.SYSTEM_TO_USER,
      user_id: null,
      user_name: "",
      body: text,
      is_anonymous: 0,
    });

    const dmContent = await formatters.formatSystemToUserDM(threadMessage);
    const dmMsg = await this._sendDMToUser(dmContent);

    if (opts.postToThreadChannel !== false) {
      const inboxContent = await formatters.formatSystemToUserThreadMessage(threadMessage);
      const finalInboxContent = typeof inboxContent === "string" ? {content: inboxContent} : inboxContent;
      finalInboxContent.allowedMentions = opts.allowedMentions;
      const inboxMsg = await this._postToThreadChannel(inboxContent);
      threadMessage.inbox_message_id = inboxMsg.id;
    }

    threadMessage.dm_channel_id = dmMsg.channel.id;
    threadMessage.dm_message_id = dmMsg.id;

    await this._addThreadMessageToDB(threadMessage.getSQLProps());
  }

  /**
   * @param {Eris.MessageContent} content
   * @param {Eris.MessageFile} file
   * @return {Promise<Eris.Message|null>}
   */
  async postNonLogMessage(content, file = null) {
    return this._postToThreadChannel(content, file);
  }

  /**
   * @param {Eris.Message} msg
   * @returns {Promise<void>}
   */
  async saveChatMessageToLogs(msg) {
    // TODO: Save attachments?
    return this._addThreadMessageToDB({
      message_type: THREAD_MESSAGE_TYPE.CHAT,
      user_id: msg.author.id,
      user_name: config.useDisplaynames ? msg.author.globalName || msg.author.username : msg.author.username,
      body: msg.content,
      is_anonymous: 0,
      dm_message_id: msg.id
    });
  }

  async saveCommandMessageToLogs(msg) {
    return this._addThreadMessageToDB({
      message_type: THREAD_MESSAGE_TYPE.COMMAND,
      user_id: msg.author.id,
      user_name: config.useDisplaynames ? msg.author.globalName || msg.author.username : msg.author.username,
      body: msg.content,
      is_anonymous: 0,
      dm_message_id: msg.id
    });
  }

  /**
   * @param {Eris.Message} msg
   * @returns {Promise<void>}
   */
  async updateChatMessageInLogs(msg) {
    await knex("thread_messages")
      .where("thread_id", this.id)
      .where("dm_message_id", msg.id)
      .update({
        body: msg.content
      });
  }

  /**
   * @param {String} messageId
   * @returns {Promise<void>}
   */
  async deleteChatMessageFromLogs(messageId) {
    await knex("thread_messages")
      .where("thread_id", this.id)
      .where("dm_message_id", messageId)
      .delete();
  }

  /**
   * @returns {Promise<ThreadMessage[]>}
   */
  async getThreadMessages() {
    const threadMessages = await knex("thread_messages")
      .where("thread_id", this.id)
      .orderBy("created_at", "ASC")
      .orderBy("id", "ASC")
      .select();

    return threadMessages.map(row => new ThreadMessage(row));
  }

  /**
   * @param {string} messageId
   * @returns {Promise<ThreadMessage|null>}
   */
  async getThreadMessageForMessageId(messageId) {
    const data = await knex("thread_messages")
      .where(function() {
        this.where("dm_message_id", messageId)
        this.orWhere("inbox_message_id", messageId)
      })
      .andWhere("thread_id", this.id)
      .first();

    return (data ? new ThreadMessage(data) : null);
  }

  async findThreadMessageByDmMessageId(messageId) {
    const data = await knex("thread_messages")
      .where("thread_id", this.id)
      .where("dm_message_id", messageId)
      .first();

    return data ? new ThreadMessage(data) : null;
  }

  /**
   * @returns {Promise<ThreadMessage>}
   */
  async getLatestThreadMessage() {
    const threadMessage = await knex("thread_messages")
      .where("thread_id", this.id)
      .andWhere(function() {
        this.where("message_type", THREAD_MESSAGE_TYPE.FROM_USER)
          .orWhere("message_type", THREAD_MESSAGE_TYPE.TO_USER)
          .orWhere("message_type", THREAD_MESSAGE_TYPE.SYSTEM_TO_USER)
      })
      .orderBy("created_at", "DESC")
      .orderBy("id", "DESC")
      .first();

      return threadMessage;
  }

  /**
   * @param {number} messageNumber
   * @returns {Promise<ThreadMessage>}
   */
  async findThreadMessageByMessageNumber(messageNumber) {
    const data = await knex("thread_messages")
      .where("thread_id", this.id)
      .where("message_number", messageNumber)
      .first();

    return data ? new ThreadMessage(data) : null;
  }

  /**
   * @returns {Promise<void>}
   */
  async close(suppressSystemMessage = false, silent = false) {
    if (! suppressSystemMessage) {
      console.log(`Closing thread ${this.id}`);

      if (silent) {
        await this.postSystemMessage("Closing thread silently...");
      } else {
        await this.postSystemMessage("Closing thread...");
      }
    }

    // Update DB status
    this.status = THREAD_STATUS.CLOSED;
    await knex("threads")
      .where("id", this.id)
      .update({
        status: THREAD_STATUS.CLOSED
      });

    // Delete channel
    const channel = bot.getChannel(this.channel_id);
    if (channel) {
      console.log(`Deleting channel ${this.channel_id}`);
      await channel.delete("Thread closed");
    }

    await callAfterThreadCloseHooks({ threadId: this.id });
  }

  /**
   * @param {String} time
   * @param {Eris~User} user
   * @param {Number} silent
   * @returns {Promise<void>}
   */
  async scheduleClose(time, user, silent) {
    await knex("threads")
      .where("id", this.id)
      .update({
        scheduled_close_at: time,
        scheduled_close_id: user.id,
        scheduled_close_name: config.useDisplaynames ? user.globalName || user.username : user.username,
        scheduled_close_silent: silent
      });

    await callAfterThreadCloseScheduledHooks({ thread: this });
  }

  /**
   * @returns {Promise<void>}
   */
  async cancelScheduledClose() {
    await knex("threads")
      .where("id", this.id)
      .update({
        scheduled_close_at: null,
        scheduled_close_id: null,
        scheduled_close_name: null,
        scheduled_close_silent: null
      });

    await callAfterThreadCloseScheduleCanceledHooks({ thread: this });
  }

  /**
   * @returns {Promise<void>}
   */
  async suspend() {
    await knex("threads")
      .where("id", this.id)
      .update({
        status: THREAD_STATUS.SUSPENDED,
        scheduled_suspend_at: null,
        scheduled_suspend_id: null,
        scheduled_suspend_name: null
      });
  }

  /**
   * @returns {Promise<void>}
   */
  async unsuspend() {
    await knex("threads")
      .where("id", this.id)
      .update({
        status: THREAD_STATUS.OPEN
      });
  }

  /**
   * @param {String} time
   * @param {Eris~User} user
   * @returns {Promise<void>}
   */
  async scheduleSuspend(time, user) {
    await knex("threads")
      .where("id", this.id)
      .update({
        scheduled_suspend_at: time,
        scheduled_suspend_id: user.id,
        scheduled_suspend_name: config.useDisplaynames ? user.globalName || user.username : user.username,
      });
  }

  /**
   * @returns {Promise<void>}
   */
  async cancelScheduledSuspend() {
    await knex("threads")
      .where("id", this.id)
      .update({
        scheduled_suspend_at: null,
        scheduled_suspend_id: null,
        scheduled_suspend_name: null
      });
  }

  /**
   * @param {String} userId
   * @returns {Promise<void>}
   */
  async addAlert(userId) {
    let alerts = await knex("threads")
      .where("id", this.id)
      .select("alert_ids")
      .first();
    alerts = alerts.alert_ids;

    if (alerts == null) {
      alerts = [userId]
    } else {
      alerts = alerts.split(",");
      if (! alerts.includes(userId)) {
        alerts.push(userId);
      }
    }

    alerts = alerts.join(",");
    await knex("threads")
      .where("id", this.id)
      .update({
        alert_ids: alerts
      });
  }

  /*
   * @param {String} userId
   * @returns {Promise<void>}
   */
  async removeAlert(userId) {
    let alerts = await knex("threads")
      .where("id", this.id)
      .select("alert_ids")
      .first();
    alerts = alerts.alert_ids;

    if (alerts != null) {
      alerts = alerts.split(",");

      for (let i = 0; i < alerts.length; i++) {
        if (alerts[i] === userId) {
          alerts.splice(i, 1);
        }
      }
    } else {
      return;
    }

    if (alerts.length === 0) {
      alerts = null;
    } else {
      alerts = alerts.join(",");
    }

    await knex("threads")
      .where("id", this.id)
      .update({
        alert_ids: alerts
      });
  }

  /**
   * @returns {Promise<void>}
   */
  async deleteAlerts() {
    await knex("threads")
      .where("id", this.id)
      .update({
        alert_ids: null
      })
  }

  /**
   * @param {Eris.Member} moderator
   * @param {ThreadMessage} threadMessage
   * @param {string} newText
   * @param {object} opts
   * @param {boolean} opts.quiet Whether to suppress edit notifications in the thread channel
   * @returns {Promise<void>}
   */
  async editStaffReply(moderator, threadMessage, newText, opts = {}) {
    const newThreadMessage = new ThreadMessage({
      ...threadMessage.getSQLProps(),
      body: newText,
    });

    const formattedThreadMessage = await formatters.formatStaffReplyThreadMessage(newThreadMessage);
    const formattedDM = await formatters.formatStaffReplyDM(newThreadMessage);

    // Same restriction as in replies. Because edits could theoretically change the number of messages a reply takes, we enforce replies
    // to fit within 1 message to avoid the headache and issues caused by that.
    if (! utils.messageContentIsWithinMaxLength(formattedDM) || ! utils.messageContentIsWithinMaxLength(formattedThreadMessage)) {
      await this.postSystemMessage("Edited reply is too long! Make sure the edit is under 2000 characters total, moderator name in the reply included.");
      return false;
    }

    await bot.editMessage(threadMessage.dm_channel_id, threadMessage.dm_message_id, formattedDM);
    await bot.editMessage(this.channel_id, threadMessage.inbox_message_id, formattedThreadMessage);

    if (! opts.quiet) {
      const editThreadMessage = new ThreadMessage({
        message_type: THREAD_MESSAGE_TYPE.REPLY_EDITED,
        user_id: null,
        user_name: "",
        body: "",
        is_anonymous: 0,
      });
      editThreadMessage.setMetadataValue("originalThreadMessage", threadMessage);
      editThreadMessage.setMetadataValue("newBody", newText);

      const threadNotification = await formatters.formatStaffReplyEditNotificationThreadMessage(editThreadMessage);
      const inboxMessage = await this._postToThreadChannel(threadNotification);
      editThreadMessage.inbox_message_id = inboxMessage.id;
      await this._addThreadMessageToDB(editThreadMessage.getSQLProps());
    }

    await this._updateThreadMessage(threadMessage.id, { body: newText });
    return true;
  }

  /**
   * @param {Eris.Member} moderator
   * @param {ThreadMessage} threadMessage
   * @param {object} opts
   * @param {boolean} opts.quiet Whether to suppress edit notifications in the thread channel
   * @returns {Promise<void>}
   */
  async deleteStaffReply(moderator, threadMessage, opts = {}) {
    await bot.deleteMessage(threadMessage.dm_channel_id, threadMessage.dm_message_id);
    await bot.deleteMessage(this.channel_id, threadMessage.inbox_message_id);

    if (! opts.quiet) {
      const deletionThreadMessage = new ThreadMessage({
        message_type: THREAD_MESSAGE_TYPE.REPLY_DELETED,
        user_id: null,
        user_name: "",
        body: "",
        is_anonymous: 0,
      });
      deletionThreadMessage.setMetadataValue("originalThreadMessage", threadMessage);

      const threadNotification = await formatters.formatStaffReplyDeletionNotificationThreadMessage(deletionThreadMessage);
      const inboxMessage = await this._postToThreadChannel(threadNotification);
      deletionThreadMessage.inbox_message_id = inboxMessage.id;
      await this._addThreadMessageToDB(deletionThreadMessage.getSQLProps());
    }

    await this._deleteThreadMessage(threadMessage.id);
  }

  /**
   * @param {String} storageType
   * @param {Object|null} storageData
   * @returns {Promise<void>}
   */
  async updateLogStorageValues(storageType, storageData) {
    this.log_storage_type = storageType;
    this.log_storage_data = storageData;

    const { log_storage_type, log_storage_data } = this.getSQLProps();

    await knex("threads")
      .where("id", this.id)
      .update({
        log_storage_type,
        log_storage_data,
      });
  }

  /**
   * @param {string} key
   * @param {*} value
   * @return {Promise<void>}
   */
  async setMetadataValue(key, value) {
    this.metadata = this.metadata || {};
    this.metadata[key] = value;

    await knex("threads")
      .where("id", this.id)
      .update({
        metadata: this.getSQLProps().metadata,
      });
  }

  /**
   * @param {string} key
   * @returns {*}
   */
  getMetadataValue(key) {
    return this.metadata ? this.metadata[key] : null;
  }

  /**
   * @returns {boolean}
   */
  isOpen() {
    return this.status === THREAD_STATUS.OPEN;
  }

  isClosed() {
    return this.status === THREAD_STATUS.CLOSED;
  }

  /**
   * Requests messages sent after last correspondence from Discord API to recover messages lost to downtime
   */
  async recoverDowntimeMessages() {
    if (await isBlocked(this.user_id)) return;

    const dmChannel = await bot.getDMChannel(this.user_id);
    if (! dmChannel) return;

    const lastMessageId = (await this.getLatestThreadMessage()).dm_message_id;
    let messages = (await dmChannel.getMessages(50, null, lastMessageId, null))
      .reverse() // We reverse the array to send the messages in the proper order - Discord returns them newest to oldest
      .filter(msg => msg.author.id === this.user_id); // Make sure we're not recovering bot or system messages

    if (messages.length === 0) return;

    await this.postSystemMessage(`📥 Recovering ${messages.length} message(s) sent by user during bot downtime!`);

    let isFirst = true;
    for (const msg of messages) {
      await this.receiveUserReply(msg, ! isFirst);
      isFirst = false;
    }
  }
}

module.exports = Thread;
