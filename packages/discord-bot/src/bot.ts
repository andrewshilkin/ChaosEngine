import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type Message,
  type SendableChannels,
} from 'discord.js';
import { addBotVoters, type ChaosEngine, type Logger, type Vote, type VoteOption } from '@chaos-engine/core';

import { saveVoteSetting, type BotConfig } from './config.js';
import { greeting } from './announce.js';
import { eventListEmbed, resultEmbed, voteButtons, voteEmbed, VOTE_BUTTON_PREFIX } from './render.js';

/**
 * The Discord frontend. It owns presentation and permissions; every decision
 * about what an event *is* or whether it may run lives in the engine and the
 * game. That boundary is what lets the same bot drive a different game.
 */
export class ChaosBot {
  private readonly client: Client;
  private voteMessage: Message | null = null;
  private voteOptions: VoteOption[] = [];
  private autoTimer: NodeJS.Timeout | null = null;
  private lastRender = 0;
  private cancelBotVoters: () => void = () => {};
  private dropTimer: NodeJS.Timeout | null = null;
  private dropAnnounced = false;
  /** A drop has to last this long before it is worth telling the channel. */
  private readonly dropAnnounceAfterMs = 120_000;

  constructor(
    private readonly cfg: BotConfig,
    private readonly engine: ChaosEngine,
    private readonly log: Logger,
    /** Where to write back settings changed from Discord. */
    private readonly configPath: string,
  ) {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
  }

  async start(): Promise<void> {
    this.client.once(Events.ClientReady, (c) => {
      this.log.info(`logged in as ${c.user.tag}`);
      void this.registerCommands();
      void this.announceStart();
      this.restartAutoLoop(this.cfg.vote.autoIntervalSeconds);
    });

    this.engine.onStatusChanged((s) => void this.announceGameStatus(s.connected));

    this.client.on(Events.InteractionCreate, (i) => void this.onInteraction(i));

    this.engine.voting.onTick((vote) => void this.renderVote(vote));
    this.engine.onVoteCompleted(({ result, execution }) => {
      void this.finishVote(result, execution);
    });

    await this.client.login(this.cfg.discord.token);
  }

  async stop(): Promise<void> {
    if (this.autoTimer) clearInterval(this.autoTimer);
    await this.client.destroy();
  }

  // -------------------------------------------------------------------------
  // commands
  // -------------------------------------------------------------------------

  private async registerCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName('chaos')
        .setDescription('Discord Chaos controls')
        .addSubcommand((s) => s.setName('vote').setDescription('Start a vote now'))
        .addSubcommand((s) => s.setName('status').setDescription('Show the game connection'))
        .addSubcommand((s) => s.setName('events').setDescription('List the available events'))
        .addSubcommand((s) =>
          s
            .setName('fire')
            .setDescription('Run one event immediately (admin)')
            .addStringOption((o) =>
              o.setName('id').setDescription('Event id').setRequired(true).setAutocomplete(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('interval')
            .setDescription('Change how often votes run automatically (admin)')
            .addIntegerOption((o) =>
              o
                .setName('seconds')
                .setDescription('Seconds between votes, or 0 to only vote on command')
                .setMinValue(0)
                .setMaxValue(86_400)
                .setRequired(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('clear')
            .setDescription('Delete recent messages in this channel (admin)')
            .addIntegerOption((o) =>
              o
                .setName('count')
                .setDescription('How many messages to delete (default 50, max 100)')
                .setMinValue(1)
                .setMaxValue(100),
            ),
        )
        .toJSON(),
    ];

    const rest = new REST().setToken(this.cfg.discord.token);
    const appId = this.client.application?.id;
    if (!appId) {
      this.log.error('no application id, cannot register commands');
      return;
    }
    await rest.put(Routes.applicationGuildCommands(appId, this.cfg.discord.guildId), {
      body: commands,
    });
    this.log.info('slash commands registered');
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isButton() && interaction.customId.startsWith(VOTE_BUTTON_PREFIX)) {
        await this.onVoteButton(interaction);
        return;
      }
      if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused().toLowerCase();
        const matches = this.engine.registry
          .all()
          .filter((e) => e.id.includes(focused) || e.name.toLowerCase().includes(focused))
          .slice(0, 25)
          .map((e) => ({ name: `${e.name} (${e.id})`.slice(0, 100), value: e.id }));
        await interaction.respond(matches);
        return;
      }
      if (interaction.isChatInputCommand() && interaction.commandName === 'chaos') {
        await this.onChaosCommand(interaction);
      }
    } catch (err) {
      this.log.error(`interaction failed: ${String(err)}`);
    }
  }

  private async onVoteButton(interaction: ButtonInteraction): Promise<void> {
    const optionId = interaction.customId.slice(VOTE_BUTTON_PREFIX.length);
    const outcome = this.engine.voting.cast(interaction.user.id, optionId);
    const label = this.voteOptions.find((o) => o.id === optionId)?.label ?? optionId;

    const text =
      outcome === 'added'
        ? `Voted for **${label}**.`
        : outcome === 'changed'
          ? `Changed your vote to **${label}**.`
          : outcome === 'unchanged'
            ? `You already voted for **${label}**.`
            : 'That vote is no longer open.';

    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });

    const vote = this.engine.voting.active;
    if (vote && outcome !== 'rejected' && outcome !== 'unchanged') {
      void this.renderVote(vote);
    }
  }

  private async onChaosCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand();

    if (sub === 'status') {
      const s = this.engine.status();
      // The game's clock stops while it is paused, so a quiet-but-recent
      // connection means "alt-tabbed", not "gone".
      const quietFor = s.lastSeen ? Date.now() - s.lastSeen : null;
      const state = s.connected
        ? quietFor !== null && quietFor > 12_000
          ? 'connected (quiet — game is probably paused or alt-tabbed)'
          : 'connected'
        : 'not connected';

      await interaction.reply({
        content:
          `**Game:** ${state}\n` +
          `**Events:** ${this.engine.registry.size}\n` +
          `**Last seen:** ${s.lastSeen ? `<t:${Math.floor(s.lastSeen / 1000)}:R>` : 'never'}\n` +
          `**Spool:** \`${s.endpoint}\``,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'events') {
      await interaction.reply({
        embeds: [eventListEmbed(this.engine.registry.all(), this.engine.connected)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'vote') {
      if (!this.isAdmin(interaction)) {
        await interaction.reply({ content: 'Not allowed.', flags: MessageFlags.Ephemeral });
        return;
      }
      const started = await this.startVote();
      await interaction.reply({
        content: started.ok ? 'Vote started.' : `Could not start a vote: ${started.reason}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'interval') {
      if (!this.isAdmin(interaction)) {
        await interaction.reply({ content: 'Not allowed.', flags: MessageFlags.Ephemeral });
        return;
      }
      const seconds = interaction.options.getInteger('seconds', true);
      this.restartAutoLoop(seconds);

      let note = '';
      try {
        await saveVoteSetting(this.configPath, 'autoIntervalSeconds', seconds);
      } catch (err) {
        // The change is live either way; only persistence failed.
        note = ' (could not save it to config.json, so it resets on restart)';
        this.log.warn(`could not persist the interval: ${String(err)}`);
      }

      await interaction.reply({
        content:
          seconds > 0
            ? `Votes will run every ${formatSeconds(seconds)}.${note}`
            : `Automatic votes are off — use \`/chaos vote\` to start one.${note}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'clear') {
      if (!this.isAdmin(interaction)) {
        await interaction.reply({ content: 'Not allowed.', flags: MessageFlags.Ephemeral });
        return;
      }
      await this.clearChannel(interaction);
      return;
    }

    if (sub === 'fire') {
      if (!this.isAdmin(interaction)) {
        await interaction.reply({ content: 'Not allowed.', flags: MessageFlags.Ephemeral });
        return;
      }
      const id = interaction.options.getString('id', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await this.engine.execute(id);
      await interaction.editReply(
        result.success
          ? `Ran **${result.name ?? id}**.`
          : `Failed: \`${result.error ?? 'unknown'}\`${result.message ? ` — ${result.message}` : ''}`,
      );
    }
  }

  /**
   * Bulk-delete recent messages in the channel the command was run in.
   *
   * Deliberately capped and never silent: it removes other people's messages,
   * so it reports exactly what it did. Discord's bulk delete refuses anything
   * older than 14 days, which is a limit of the API, not a choice here.
   */
  private async clearChannel(interaction: ChatInputCommandInteraction): Promise<void> {
    const count = interaction.options.getInteger('count') ?? 50;
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      await interaction.reply({
        content: 'That only works in a server text channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const deleted = await channel.bulkDelete(count, true);
      const shortfall = count - deleted.size;
      await interaction.editReply(
        `Deleted ${deleted.size} message(s).` +
          (shortfall > 0
            ? ` ${shortfall} were skipped — Discord will not bulk delete messages older than 14 days.`
            : ''),
      );
      this.log.info(`cleared ${deleted.size} message(s) in ${channel.id}`);
    } catch (err) {
      await interaction.editReply(
        'Could not delete messages. The bot needs the **Manage Messages** permission in this channel.',
      );
      this.log.warn(`clear failed: ${String(err)}`);
    }
  }

  private isAdmin(interaction: ChatInputCommandInteraction): boolean {
    const member = interaction.member as GuildMember | null;
    if (!member) return false;
    if (this.cfg.discord.adminRoleId) {
      return member.roles.cache.has(this.cfg.discord.adminRoleId);
    }
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  }

  // -------------------------------------------------------------------------
  // votes
  // -------------------------------------------------------------------------

  /** Say hello in the channel so the community can see the bot is up. */
  private async announceStart(): Promise<void> {
    if (!this.cfg.announce.onStart) return;
    const channel = await this.voteChannel();
    if (!channel) return;

    const every = this.cfg.vote.autoIntervalSeconds;
    await channel
      .send(
        `**DISCORD CHAOS** — ${greeting()}\n` +
          (every > 0
            ? `A vote every ${formatSeconds(every)}. Use \`/chaos events\` to see what can happen.`
            : 'Votes are on demand — an admin starts one with `/chaos vote`.'),
      )
      .catch((err: unknown) => this.log.warn(`could not announce start: ${String(err)}`));
  }

  /**
   * Report the game coming and going -- but not every flap.
   *
   * The game's clock stops while it is paused, so a player alt-tabbing makes
   * the connection appear to drop and return within seconds. Announcing that
   * every time would bury the channel, so a drop is only reported once it has
   * lasted, and a reconnect only if a drop was reported.
   */
  private async announceGameStatus(connected: boolean): Promise<void> {
    if (!this.cfg.announce.onGameConnect) return;

    if (connected) {
      if (this.dropTimer) {
        // Back before the drop was ever announced: nothing happened.
        clearTimeout(this.dropTimer);
        this.dropTimer = null;
        return;
      }
      if (!this.dropAnnounced) return;
      this.dropAnnounced = false;
      const channel = await this.voteChannel();
      await channel
        ?.send(`🟢 Game connected — ${this.engine.registry.size} events armed.`)
        .catch(() => {});
      return;
    }

    this.dropTimer = setTimeout(() => {
      this.dropTimer = null;
      this.dropAnnounced = true;
      void (async () => {
        const channel = await this.voteChannel();
        await channel
          ?.send('🔴 Lost the game. Votes are paused until it is back.')
          .catch(() => undefined);
      })();
    }, this.dropAnnounceAfterMs);
  }

  /** (Re)start the auto-vote loop. 0 seconds turns it off. */
  restartAutoLoop(seconds: number): void {
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
    this.cfg.vote.autoIntervalSeconds = seconds;
    if (seconds <= 0) {
      this.log.info('auto votes disabled');
      return;
    }
    this.startAutoLoop();
  }

  private startAutoLoop(): void {
    const intervalMs = this.cfg.vote.autoIntervalSeconds * 1000;
    this.autoTimer = setInterval(() => {
      if (this.engine.voting.active) return;
      if (!this.engine.connected) {
        this.log.info('skipping the scheduled vote: the game has gone quiet');
        return;
      }
      void this.startVote().then((r) => {
        if (!r.ok) this.log.warn(`scheduled vote skipped: ${r.reason}`);
      });
    }, intervalMs);
    this.log.info(`auto votes every ${this.cfg.vote.autoIntervalSeconds}s`);
  }

  async startVote(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.engine.voting.active) {
      return { ok: false, reason: 'a vote is already running' };
    }
    // Deliberately not requiring a live connection. The game's clock stops
    // while it is paused, which is exactly what happens when someone alt-tabs
    // to Discord to run this command. Commands queue in the spool and land when
    // the player is back in game.
    if (this.engine.registry.size === 0) {
      return {
        ok: false,
        reason: 'the game has never reported in — is Anomaly running with a save loaded?',
      };
    }

    const options = this.engine.ballot({
      size: this.cfg.vote.optionCount,
      strategy: this.cfg.vote.strategy,
      maxPerCategory: this.cfg.vote.maxPerCategory,
    });
    if (options.length < 2) {
      return {
        ok: false,
        reason: `only ${options.length} event(s) are available right now — the rest are on cooldown`,
      };
    }

    const channel = await this.voteChannel();
    if (!channel) {
      return {
        ok: false,
        reason: `channel \`${this.cfg.discord.channelId}\` is not a text channel I can post in`,
      };
    }

    this.voteOptions = options;
    const vote = this.engine.startVote(options, this.cfg.vote.durationSeconds);
    this.cancelBotVoters = addBotVoters(vote, options, {
      count: this.cfg.vote.botVoters,
      durationSeconds: this.cfg.vote.durationSeconds,
    });
    this.voteMessage = await channel.send({
      embeds: [voteEmbed(vote)],
      components: voteButtons(options),
    });
    this.lastRender = Date.now();
    this.log.info(`vote started: ${options.map((o) => o.id).join(', ')}`);
    return { ok: true };
  }

  /** Discord rate limits edits, so the board refreshes at most every 2 seconds. */
  private async renderVote(vote: Vote): Promise<void> {
    if (!this.voteMessage) return;
    const now = Date.now();
    if (now - this.lastRender < 2000 && vote.secondsLeft() > 1) return;
    this.lastRender = now;
    try {
      await this.voteMessage.edit({ embeds: [voteEmbed(vote)], components: voteButtons(this.voteOptions) });
    } catch (err) {
      this.log.warn(`could not update the vote message: ${String(err)}`);
    }
  }

  private async finishVote(
    result: Parameters<Parameters<ChaosEngine['onVoteCompleted']>[0]>[0]['result'],
    execution: Parameters<Parameters<ChaosEngine['onVoteCompleted']>[0]>[0]['execution'],
  ): Promise<void> {
    const message = this.voteMessage;
    this.voteMessage = null;

    if (message) {
      try {
        await message.edit({
          embeds: [resultEmbed(result, execution)],
          components: voteButtons(this.voteOptions, true),
        });
      } catch (err) {
        this.log.warn(`could not finalise the vote message: ${String(err)}`);
      }
    }
    this.log.info(
      `vote finished: ${result.winner.id} (${result.totalVotes} votes), executed=${execution?.success ?? false}`,
    );
  }

  private async voteChannel(): Promise<SendableChannels | null> {
    const channel = await this.client.channels.fetch(this.cfg.discord.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !channel.isSendable()) {
      this.log.error(`channel ${this.cfg.discord.channelId} is not a text channel the bot can post in`);
      return null;
    }
    return channel;
  }
}

/** "180" -> "3 minutes", for messages people read rather than parse. */
function formatSeconds(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  if (seconds % 60 === 0) return `${seconds / 60} minute(s)`;
  return `${seconds} seconds`;
}
