import irc from 'irc-upd';
import discord, {
  AnyChannel,
  BaseGuildTextChannel,
  Intents,
  TextChannel,
  WebhookClient,
} from 'discord.js';
import { logger } from './logger';
import { validateChannelMapping } from './validators';
import { formatFromDiscordToIRC, formatFromIRCToDiscord } from './formatting';

// Usernames need to be between 2 and 32 characters for webhooks:
const USERNAME_MIN_LENGTH = 2;
const USERNAME_MAX_LENGTH = 32;

const REQUIRED_FIELDS = [
  'server',
  'nickname',
  'channelMapping',
  'discordToken',
];
const DEFAULT_NICK_COLORS = [
  'light_blue',
  'dark_blue',
  'light_red',
  'dark_red',
  'light_green',
  'dark_green',
  'magenta',
  'light_magenta',
  'orange',
  'yellow',
  'cyan',
  'light_cyan',
];
const patternMatch = /{\$(.+?)}/g;

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options - server, nickname, channelMapping, outgoingToken, incomingURL
 */
class Bot {
  discord: discord.Client;

  server;
  nickname;
  ircOptions;
  discordToken;
  commandCharacters: string[];
  ircNickColor;
  ircNickColors;
  parallelPingFix;
  channels;
  ircStatusNotices;
  announceSelfJoin;
  webhookOptions;
  ignoreUsers;

  format;
  formatIRCText;
  formatURLAttachment;
  formatCommandPrelude;
  formatDiscord;
  formatWebhookAvatarURL;
  channelUsers;
  channelMapping;
  webhooks: Record<string, { id: unknown; client: WebhookClient }>;
  invertedMapping;
  autoSendCommands;
  ircClient;

  constructor(options: Record<string, unknown>) {
    for (const field of REQUIRED_FIELDS) {
      if (!options[field]) {
        throw new Error(`Missing configuration field: ${field}`);
      }
    }

    validateChannelMapping(options.channelMapping);

    this.discord = new discord.Client({
      retryLimit: 3,
      intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES],
    });

    this.server = options.server;
    this.nickname = options.nickname;
    this.ircOptions = options.ircOptions;
    this.discordToken = options.discordToken;
    this.commandCharacters = (options.commandCharacters as string[]) || [];
    this.ircNickColor = options.ircNickColor !== false; // default to true
    this.ircNickColors = options.ircNickColors || DEFAULT_NICK_COLORS;
    this.parallelPingFix = options.parallelPingFix === true; // default: false
    this.channels = Object.values(
      options.channelMapping as Record<string, string>,
    );
    this.ircStatusNotices = options.ircStatusNotices;
    this.announceSelfJoin = options.announceSelfJoin;
    this.webhookOptions = options.webhooks;

    // Nicks to ignore
    this.ignoreUsers = options.ignoreUsers || {};
    this.ignoreUsers.irc = this.ignoreUsers.irc || [];
    this.ignoreUsers.discord = this.ignoreUsers.discord || [];
    this.ignoreUsers.discordIds = this.ignoreUsers.discordIds || [];

    // "{$keyName}" => "variableValue"
    // author/nickname: nickname of the user who sent the message
    // discordChannel: Discord channel (e.g. #general)
    // ircChannel: IRC channel (e.g. #irc)
    // text: the (appropriately formatted) message content
    this.format = options.format || {};

    // "{$keyName}" => "variableValue"
    // displayUsername: nickname with wrapped colors
    // attachmentURL: the URL of the attachment (only applicable in formatURLAttachment)
    this.formatIRCText = this.format.ircText || '<{$displayUsername}> {$text}';
    this.formatURLAttachment =
      this.format.urlAttachment || '<{$displayUsername}> {$attachmentURL}';

    // "{$keyName}" => "variableValue"
    // side: "Discord" or "IRC"
    if ('commandPrelude' in this.format) {
      this.formatCommandPrelude = this.format.commandPrelude;
    } else {
      this.formatCommandPrelude = 'Command sent from {$side} by {$nickname}:';
    }

    // "{$keyName}" => "variableValue"
    // withMentions: text with appropriate mentions reformatted
    this.formatDiscord =
      this.format.discord || '**<{$author}>** {$withMentions}';

    // "{$keyName} => "variableValue"
    // nickname: nickame of IRC message sender
    this.formatWebhookAvatarURL = this.format.webhookAvatarURL;

    // Keep track of { channel => [list, of, usernames] } for ircStatusNotices
    this.channelUsers = {};

    this.channelMapping = {};
    this.invertedMapping = {};
    this.webhooks = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    for (const [discordChan, ircChan] of Object.entries(
      options.channelMapping as Record<string, string>,
    )) {
      const splut = ircChan.split(' ')[0].toLowerCase();
      this.channelMapping[discordChan] = splut;
      this.invertedMapping[splut] = discordChan;
    }

    this.autoSendCommands = options.autoSendCommands || [];
  }

  async connect(): Promise<void> {
    logger.debug('Connecting to IRC and Discord');
    await this.discord.login(this.discordToken);

    // Extract id and token from Webhook urls and connect.
    for (const [channel, url] of Object.entries(
      (this.webhookOptions ?? {}) as Record<string, string>,
    )) {
      const [id, token] = url.split('/').slice(-2);
      // TODO: surely this is completely wrong, the types do not allow anything like this
      const client = new discord.WebhookClient(id as any, token as any);
      this.webhooks[channel] = {
        id,
        client,
      };
    }

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      retryCount: 10,
      autoRenick: true,
      // options specified in the configuration file override the above defaults
      ...this.ircOptions,
    };

    // default encoding to UTF-8 so messages to Discord aren't corrupted
    if (!Object.prototype.hasOwnProperty.call(ircOptions, 'encoding')) {
      if (irc.canConvertEncoding()) {
        ircOptions.encoding = 'utf-8';
      } else {
        logger.warn(
          'Cannot convert message encoding; you may encounter corrupted characters with non-English text.\n' +
            'For information on how to fix this, please see: https://github.com/Throne3d/node-irc#character-set-detection',
        );
      }
    }

    this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
    this.attachListeners();
  }

  disconnect() {
    this.ircClient.disconnect();
    this.discord.destroy();
    for (const x of Object.values(this.webhooks)) {
      x.client.destroy();
    }
  }

  attachListeners() {
    this.discord.on('ready', () => {
      logger.info('Connected to Discord');
    });

    this.ircClient.on('registered', (message) => {
      logger.info('Connected to IRC');
      logger.debug('Registered event: ', message);
      for (const element of this.autoSendCommands) {
        this.ircClient.send(...element);
      }
    });

    this.ircClient.on('error', (error) => {
      logger.error('Received error event from IRC', error);
    });

    this.discord.on('error', (error) => {
      logger.error('Received error event from Discord', error);
    });

    this.discord.on('warn', (warning) => {
      logger.warn('Received warn event from Discord', warning);
    });

    this.discord.on('message', (message) => {
      // Ignore bot messages and people leaving/joining
      this.sendToIRC(message);
    });

    // TODO: almost certainly not async safe
    this.ircClient.on('message', this.sendToDiscord.bind(this));

    // TODO: almost certainly not async safe
    this.ircClient.on('notice', async (author, to, text) =>
      this.sendToDiscord(author, to, `*${text}*`),
    );

    // TODO: almost certainly not async safe
    this.ircClient.on('nick', async (oldNick, newNick, channels) => {
      if (!this.ircStatusNotices) return;
      for (const channelName of channels) {
        const channel = channelName.toLowerCase();
        if (this.channelUsers[channel]) {
          if (this.channelUsers[channel].has(oldNick)) {
            this.channelUsers[channel].delete(oldNick);
            this.channelUsers[channel].add(newNick);
            await this.sendExactToDiscord(
              channel,
              `*${oldNick}* is now known as ${newNick}`,
            );
          }
        } else {
          logger.warn(
            `No channelUsers found for ${channel} when ${oldNick} changed.`,
          );
        }
      }
    });

    // TODO: almost certainly not async safe
    this.ircClient.on('join', async (channelName, nick) => {
      logger.debug('Received join:', channelName, nick);
      if (!this.ircStatusNotices) return;
      if (nick === this.ircClient.nick && !this.announceSelfJoin) return;
      const channel = channelName.toLowerCase();
      // self-join is announced before names (which includes own nick)
      // so don't add nick to channelUsers
      if (nick !== this.ircClient.nick) this.channelUsers[channel].add(nick);
      await this.sendExactToDiscord(
        channel,
        `*${nick}* has joined the channel`,
      );
    });

    // TODO: almost certainly not async safe
    this.ircClient.on('part', async (channelName, nick, reason) => {
      logger.debug('Received part:', channelName, nick, reason);
      if (!this.ircStatusNotices) return;
      const channel = channelName.toLowerCase();
      // remove list of users when no longer in channel (as it will become out of date)
      if (nick === this.ircClient.nick) {
        logger.debug('Deleting channelUsers as bot parted:', channel);
        delete this.channelUsers[channel];
        return;
      }
      if (this.channelUsers[channel]) {
        this.channelUsers[channel].delete(nick);
      } else {
        logger.warn(
          `No channelUsers found for ${channel} when ${nick} parted.`,
        );
      }
      await this.sendExactToDiscord(
        channel,
        `*${nick}* has left the channel (${reason})`,
      );
    });

    // TODO: almost certainly not async safe
    this.ircClient.on('quit', async (nick, reason, channels) => {
      logger.debug('Received quit:', nick, channels);
      if (!this.ircStatusNotices || nick === this.ircClient.nick) return;
      for (const channelName of channels) {
        const channel = channelName.toLowerCase();
        if (!this.channelUsers[channel]) {
          logger.warn(
            `No channelUsers found for ${channel} when ${nick} quit, ignoring.`,
          );
          continue;
        }
        if (!this.channelUsers[channel].delete(nick)) continue;
        await this.sendExactToDiscord(
          channel,
          `*${nick}* has quit (${reason})`,
        );
      }
    });

    this.ircClient.on('names', (channelName, nicks) => {
      logger.debug('Received names:', channelName, nicks);
      if (!this.ircStatusNotices) return;
      const channel = channelName.toLowerCase();
      this.channelUsers[channel] = new Set(Object.keys(nicks));
    });

    // TODO: almost certainly not async safe
    this.ircClient.on('action', async (author, to, text) =>
      this.sendToDiscord(author, to, `_${text}_`),
    );

    this.ircClient.on('invite', (channel, from) => {
      logger.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('Joining channel:', channel);
      }
    });

    if (logger.level === 'debug') {
      this.discord.on('debug', (message) => {
        logger.debug('Received debug event from Discord', message);
      });
    }
  }

  static getDiscordNicknameOnServer(user, guild) {
    if (guild) {
      const userDetails = guild.members.cache.get(user.id);
      if (userDetails) {
        return userDetails.nickname || user.username;
      }
    }
    return user.username;
  }

  parseText(message: discord.Message): string {
    const usedFields = ['title', 'description', 'fields', 'image', 'footer'];
    let embed = '';
    if (message.embeds?.length) {
      for (const key of usedFields) {
        if (!message.embeds[0][key]) {
          continue;
        }
        if (key === 'fields') {
          for (const field of message.embeds[0][key]) {
            let { value } = field;
            const discId = value.match(/<@[0-9]+>/g);
            if (discId) {
              for (const id of discId) {
                const dId = id.substring(2, id.length - 1);
                const name = (this.discord.users as any).find(
                  'id',
                  dId,
                ).username;
                value = value.replace(id, name);
              }
            }
            embed += `\u0002${field.name}\u0002\n${value}\n`;
          }
        } else if (key === 'image') {
          embed += `${message.embeds[0][key].url}\n`;
        } else if (key === 'footer') {
          embed += message.embeds[0][key].text;
        } else if (key === 'title') {
          embed += `\u0002${message.embeds[0][key]}\u0002\n`;
        } else {
          embed += `${message.embeds[0][key]}\n`;
        }
      }
    }
    let text = message.mentions.users.reduce((content, mention) => {
      const displayName = Bot.getDiscordNicknameOnServer(
        mention,
        message.guild,
      );
      const userMentionRegex = RegExp(`<@(&|!)?${mention.id}>`, 'g');
      return content.replace(userMentionRegex, `@${displayName}`);
    }, message.content);

    text = `${text}\n${embed}`;
    text = text.trim();

    return text
      .replace(/<#(\d+)>/g, (match, channelId) => {
        const channel = this.discord.channels.cache.get(channelId);
        if (channel && 'name' in channel) return `#${channel.name}`;
        return '#deleted-channel';
      })
      .replace(/<@&(\d+)>/g, (match, roleId) => {
        const role = message.guild?.roles.cache.get(roleId);
        if (role) return `@${role.name}`;
        return '@deleted-role';
      })
      .replace(/<a?(:\w+:)\d+>/g, (match, emoteName) => emoteName);
  }

  isCommandMessage(message: string) {
    return this.commandCharacters.some((prefix) => message.startsWith(prefix));
  }

  ignoredIrcUser(user) {
    return this.ignoreUsers.irc.some(
      (i) => i.toLowerCase() === user.toLowerCase(),
    );
  }

  ignoredDiscordUser(discordUser: discord.User) {
    const ignoredName = this.ignoreUsers.discord.some(
      (i) => i.toLowerCase() === discordUser.username.toLowerCase(),
    );
    const ignoredId = this.ignoreUsers.discordIds.some(
      (i) => i === discordUser.id,
    );
    return ignoredName || ignoredId;
  }

  static substitutePattern(message: string, patternMapping) {
    return message.replace(
      patternMatch,
      (match, varName) => patternMapping[varName] || match,
    );
  }

  sendToIRC(message: discord.Message) {
    const { author } = message;
    // Ignore messages sent by the bot itself:
    if (
      author.id === this.discord.user?.id ||
      Object.keys(this.webhooks).some(
        (channel) => this.webhooks[channel].id === author.id,
      )
    )
      return;

    // Do not send to IRC if this user is on the ignore list.
    if (this.ignoredDiscordUser(author)) {
      return;
    }

    if (!isTextChannel(message.channel)) return;

    const channelName = `#${message.channel.name}`;
    const ircChannel =
      this.channelMapping[message.channel.id] ||
      this.channelMapping[channelName];

    logger.debug(
      'Channel Mapping',
      channelName,
      this.channelMapping[channelName],
    );
    if (ircChannel) {
      const fromGuild = message.guild;
      const nickname = Bot.getDiscordNicknameOnServer(author, fromGuild);
      let text = this.parseText(message);
      let displayUsername = nickname;

      if (this.parallelPingFix) {
        // Prevent users of both IRC and Discord from
        // being mentioned in IRC when they talk in Discord.
        displayUsername = `${displayUsername.slice(
          0,
          1,
        )}\u200B${displayUsername.slice(1)}`;
      }

      if (this.ircNickColor) {
        const colorIndex =
          (nickname.charCodeAt(0) + nickname.length) %
          this.ircNickColors.length;
        displayUsername = irc.colors.wrap(
          this.ircNickColors[colorIndex],
          displayUsername,
        );
      }

      const patternMap = {
        author: nickname,
        nickname,
        displayUsername,
        text,
        discordChannel: channelName,
        ircChannel,
        side: undefined as unknown,
        attachmentURL: undefined as unknown,
      };

      if (this.isCommandMessage(text)) {
        patternMap.side = 'Discord';
        logger.debug('Sending command message to IRC', ircChannel, text);
        // if (prelude) this.ircClient.say(ircChannel, prelude);
        if (this.formatCommandPrelude) {
          const prelude = Bot.substitutePattern(
            this.formatCommandPrelude,
            patternMap,
          );
          this.ircClient.say(ircChannel, prelude);
        }
        this.ircClient.say(ircChannel, text);
      } else {
        if (text !== '') {
          // Convert formatting

          text = text.replace('\r\n', '\n').replace('\r', '\n');
          const sentences = text.split('\n');

          for (const orig of sentences) {
            let sentence = formatFromDiscordToIRC(orig);
            if (sentence) {
              patternMap.text = sentence;
              sentence = Bot.substitutePattern(this.formatIRCText, patternMap);
              logger.debug('Sending message to IRC', ircChannel, sentence);
              this.ircClient.say(ircChannel, sentence);
            }
          }
        }

        if (message.attachments && message.attachments.size) {
          // attachments are a discord.Collection, not a JS object
          message.attachments.forEach((a) => {
            patternMap.attachmentURL = a.url;
            const urlMessage = Bot.substitutePattern(
              this.formatURLAttachment,
              patternMap,
            );

            logger.debug(
              'Sending attachment URL to IRC',
              ircChannel,
              urlMessage,
            );
            this.ircClient.say(ircChannel, urlMessage);
          });
        }
      }
    }
  }

  findDiscordChannel(ircChannel: string) {
    const discordChannelName = this.invertedMapping[ircChannel.toLowerCase()];
    if (discordChannelName) {
      // #channel -> channel before retrieving and select only text channels:
      let discordChannel: BaseGuildTextChannel | undefined;

      if (this.discord.channels.cache.has(discordChannelName)) {
        discordChannel = this.discord.channels.cache.get(discordChannelName) as
          | BaseGuildTextChannel
          | undefined;
      } else if (discordChannelName.startsWith('#')) {
        discordChannel = this.discord.channels.cache
          // unclear if this UNKNOWN is a test bug or happens in the real world
          .filter(
            (c: any) =>
              c.type === 'text' ||
              c.type === 'UNKNOWN' ||
              c.type === 'GUILD_TEXT',
          )
          .find(
            (c) =>
              (c as BaseGuildTextChannel).name === discordChannelName.slice(1),
          ) as BaseGuildTextChannel | undefined;
      }

      if (!discordChannel) {
        logger.info(
          "Tried to send a message to a channel the bot isn't in: ",
          discordChannelName,
        );
        return null;
      }
      return discordChannel;
    }
    return null;
  }

  findWebhook(ircChannel: string) {
    const discordChannelName = this.invertedMapping[ircChannel.toLowerCase()];
    return discordChannelName && this.webhooks[discordChannelName];
  }

  getDiscordAvatar(nick: string, channel: string) {
    const discordChannel = this.findDiscordChannel(channel);
    if (!discordChannel) return null;
    const guildMembers = discordChannel.guild.members.cache;
    const findByNicknameOrUsername = (caseSensitive) => (member) => {
      if (caseSensitive) {
        return member.user.username === nick || member.nickname === nick;
      }
      const nickLowerCase = nick.toLowerCase();
      return (
        member.user.username.toLowerCase() === nickLowerCase ||
        (member.nickname && member.nickname.toLowerCase() === nickLowerCase)
      );
    };

    // Try to find exact matching case
    let users = guildMembers.filter(findByNicknameOrUsername(true));

    // Now let's search case insensitive.
    if (users.size === 0) {
      users = guildMembers.filter(findByNicknameOrUsername(false));
    }

    // No matching user or more than one => default avatar
    if (users && users.size === 1) {
      const url = users.first()?.user.avatarURL({ size: 128, format: 'png' });
      if (url) return url;
    }

    // If there isn't a URL format, don't send an avatar at all
    if (this.formatWebhookAvatarURL) {
      return Bot.substitutePattern(this.formatWebhookAvatarURL, {
        nickname: nick,
      });
    }
    return null;
  }

  // compare two strings case-insensitively
  // for discord mention matching
  static caseComp(str1, str2) {
    return str1.toUpperCase() === str2.toUpperCase();
  }

  // check if the first string starts with the second case-insensitively
  // for discord mention matching
  static caseStartsWith(str1, str2) {
    return str1.toUpperCase().startsWith(str2.toUpperCase());
  }

  async sendToDiscord(author, channel, text) {
    const discordChannel = this.findDiscordChannel(channel);
    if (!discordChannel) return;

    // Do not send to Discord if this user is on the ignore list.
    if (this.ignoredIrcUser(author)) {
      return;
    }

    // Convert text formatting (bold, italics, underscore)
    const withFormat = formatFromIRCToDiscord(text);

    const patternMap = {
      author,
      nickname: author,
      displayUsername: author,
      text: withFormat,
      discordChannel: `#${discordChannel.name}`,
      ircChannel: channel,
      side: undefined as unknown,
      withMentions: undefined as unknown,
      withFilteredMentions: undefined as unknown,
    };

    if (this.isCommandMessage(text)) {
      patternMap.side = 'IRC';
      logger.debug(
        'Sending command message to Discord',
        `#${discordChannel.name}`,
        text,
      );
      if (this.formatCommandPrelude) {
        const prelude = Bot.substitutePattern(
          this.formatCommandPrelude,
          patternMap,
        );
        await discordChannel.send(prelude);
      }
      await discordChannel.send(text);
      return;
    }

    const { guild } = discordChannel;
    const withMentions = withFormat
      // @ts-expect-error TS doesn't seem to see the valid overload of replace here?
      .replace(/@([^\s#]+)#(\d+)/g, (match, username, discriminator) => {
        // @username#1234 => mention
        // skips usernames including spaces for ease (they cannot include hashes)
        // checks case insensitively as Discord does
        const user = guild.members.cache.find(
          (x) =>
            Bot.caseComp(x.user.username, username) &&
            x.user.discriminator === discriminator,
        );
        if (user) return user;

        return match;
      })
      // @ts-expect-error TS doesn't seem to see the valid overload of replace here?
      .replace(/:(\w+):/g, (match, ident) => {
        // :emoji: => mention, case sensitively
        const emoji = guild.emojis.cache.find(
          // @ts-expect-error TS doesn't seem to see the valid overload of replace here?
          (x) => x.name === ident && x.requiresColons,
        );
        if (emoji) return emoji;

        return match;
      })
      // @ts-expect-error TS doesn't seem to see the valid overload of replace here?
      .replace(/#([^\s#@'!?,.]+)/g, (match, channelName) => {
        // channel names can't contain spaces, #, @, ', !, ?, , or .
        // (based on brief testing. they also can't contain some other symbols,
        // but these seem likely to be common around channel references)

        // discord matches channel names case insensitively
        const chan = guild.channels.cache.find((x) =>
          Bot.caseComp(x.name, channelName),
        );
        return chan || match;
      });

    // Webhooks first
    const webhook = this.findWebhook(channel);
    if (webhook) {
      logger.debug(
        'Sending message to Discord via webhook',
        withMentions,
        channel,
        '->',
        `#${discordChannel.name}`,
      );
      const permissions = discordChannel.permissionsFor(this.discord.user!);
      let canPingEveryone = false;
      if (permissions) {
        canPingEveryone = permissions.has(
          discord.Permissions.FLAGS.MENTION_EVERYONE,
        );
      }
      const avatarURL = this.getDiscordAvatar(author, channel);
      const username = author
        .substring(0, USERNAME_MAX_LENGTH)
        .padEnd(USERNAME_MIN_LENGTH, '_');
      webhook.client
        .send(withMentions, {
          username,
          avatarURL,
          disableMentions: canPingEveryone ? 'none' : 'everyone',
        })
        .catch(logger.error);
      return;
    }

    patternMap.withMentions = withMentions;
    patternMap.withFilteredMentions = withMentions.replace(
      /@(here|everyone)/gi,
      (match, part) => `ම${part}`,
    );

    // Add bold formatting:
    // Use custom formatting from config / default formatting with bold author
    const withAuthor = Bot.substitutePattern(this.formatDiscord, patternMap);
    logger.debug(
      'Sending message to Discord',
      withAuthor,
      channel,
      '->',
      `#${discordChannel.name}`,
    );
    await discordChannel.send(withAuthor);
  }

  /* Sends a message to Discord exactly as it appears */
  async sendExactToDiscord(channel: string, text: string): Promise<void> {
    const discordChannel = this.findDiscordChannel(channel);
    if (!discordChannel) return;

    logger.debug(
      'Sending special message to Discord',
      text,
      channel,
      '->',
      `#${discordChannel.name}`,
    );
    await discordChannel.send(text);
  }
}

export const TEST_HACK_CHANNEL = Symbol();

const isTextChannel = (channel: AnyChannel): channel is TextChannel =>
  channel instanceof BaseGuildTextChannel || TEST_HACK_CHANNEL in channel;

export default Bot;
