import { vi } from 'vitest';
import events from 'events';
import discord, { Options } from 'discord.js';

export default function createDiscordStub(sendStub) {
  return class DiscordStub extends events.EventEmitter {
    user;
    options;
    channels;
    users;
    guilds;
    rest;

    constructor() {
      super();
      this.user = {
        id: 'testid',
      };
      this.options = {
        http: {
          cdn: '',
        },
        makeCache: Options.cacheEverything(),
      };
      // @ts-expect-error private but only at compile time
      this.channels = new discord.ChannelManager(this, []);

      // @ts-expect-error private but only at compile time
      this.users = new discord.UserManager(this, []);
      // @ts-expect-error private but only at compile time
      this.guilds = new discord.GuildManager(this, []);
      const guild = this.createGuildStub();
      this.guilds.cache.set(guild.id, guild);

      this.rest = this.createRestStub();
    }

    destroy() {}

    addTextChannel(guild, textChannel) {
      const textChannelData = {
        type: discord.Constants.ChannelTypes.GUILD_TEXT,
        ...textChannel,
      };
      // @ts-expect-error private but only at compile time
      const textChannelObj = new discord.TextChannel(guild, textChannelData);
      textChannelObj.send = sendStub;
      const permissions = new discord.Collection();
      textChannelObj.setPermissionStub = (user, perms) =>
        permissions.set(user, perms);
      textChannelObj.permissionsFor = (user) => permissions.get(user);
      this.channels.cache.set(textChannelObj.id, textChannelObj);
      return textChannelObj;
    }

    createGuildStub(guildData = {}) {
      const guild = {
        id: '1',
        client: this,
        addTextChannel: (textChannel) => {
          const textChannelObj = this.addTextChannel(guild, textChannel);
          textChannelObj.guild.channels.cache.set(
            textChannelObj.id,
            textChannelObj,
          );
          return textChannelObj;
        },
      };
      // @ts-expect-error private but only at compile time
      guild.roles = new discord.RoleManager(guild, []);
      // @ts-expect-error private but only at compile time
      guild.members = new discord.GuildMemberManager(guild, []);
      // @ts-expect-error private but only at compile time
      guild.emojis = new discord.GuildEmojiManager(guild, []);
      // @ts-expect-error private but only at compile time
      guild.channels = new discord.GuildChannelManager(guild, []);
      Object.assign(guild, guildData);
      this.guilds.cache.set(guild.id, guild);

      if (guild.id === '1') {
        guild.addTextChannel({
          name: 'discord',
          id: '1234',
        });
      }

      return guild;
    }

    createRestStub() {
      return {
        cdn: discord.Constants.Endpoints.CDN(''),
      };
    }

    login() {
      return vi.fn();
    }
  };
}
