import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export interface BotConfig {
  discord: {
    token: string;
    /** Channel the bot posts votes in. */
    channelId: string;
    /** Guild to register slash commands in (instant, unlike global commands). */
    guildId: string;
    /** Role allowed to use the admin commands. Empty means "server managers". */
    adminRoleId?: string;
  };
  vote: {
    durationSeconds: number;
    optionCount: number;
    maxPerCategory: number;
    /**
     * 'groups' offers one event per category, so a ballot spans a monster, some
     * loot, a world change and so on. 'flat' weights across everything.
     */
    strategy: 'groups' | 'flat';
    /**
     * Automated voters added to every vote, so a quiet channel still produces a
     * result worth watching. They appear in the tally as ordinary votes and a
     * human majority always overrules them.
     */
    botVoters: number;
    /**
     * How many past ballots an event is kept off the next one for. Weighting
     * alone is not enough to stop the same names coming round every vote.
     */
    avoidRepeatsFor: number;
    /** Seconds between automatic votes. 0 disables the auto loop. */
    autoIntervalSeconds: number;
  };
  announce: {
    /** Post a message in the vote channel when the bot comes up. */
    onStart: boolean;
    /** Post a message when the game connects or drops for good. */
    onGameConnect: boolean;
  };
  game: {
    /** Explicit spool directory. Takes precedence over gameRoot. */
    spoolDir?: string;
    /** Game install folder; the spool is <gameRoot>/appdata/chaos. */
    gameRoot?: string;
    /** Path to the adapter's events.json. */
    manifest?: string;
    globalCooldownSeconds: number;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Where the token came from, so a bad one can be traced to its source. */
  tokenSource: string;
}

const DEFAULTS: BotConfig = {
  discord: { token: '', channelId: '', guildId: '' },
  vote: {
    durationSeconds: 20,
    optionCount: 4,
    maxPerCategory: 2,
    strategy: 'groups',
    botVoters: 2,
    avoidRepeatsFor: 2,
    autoIntervalSeconds: 0,
  },
  announce: { onStart: true, onGameConnect: true },
  game: { globalCooldownSeconds: 0 },
  logLevel: 'info',
  tokenSource: '',
};

/**
 * config.json is the only source of configuration.
 *
 * Environment variables used to override it, which meant a stale DISCORD_TOKEN
 * in a terminal could silently beat the token in the file, with discord.js
 * reporting only "an invalid token was provided". One source, no surprises.
 */
export async function loadConfig(file: string): Promise<BotConfig> {
  let fromFile: Partial<BotConfig> = {};
  try {
    fromFile = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<BotConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const cfg: BotConfig = {
    discord: { ...DEFAULTS.discord, ...fromFile.discord },
    vote: { ...DEFAULTS.vote, ...fromFile.vote },
    game: { ...DEFAULTS.game, ...fromFile.game },
    announce: { ...DEFAULTS.announce, ...fromFile.announce },
    logLevel: fromFile.logLevel ?? DEFAULTS.logLevel,
    tokenSource: `the "discord.token" field in ${path.resolve(file)}`,
  };


  const missing: string[] = [];
  if (!cfg.discord.token) missing.push('discord.token');
  if (!cfg.discord.channelId) missing.push('discord.channelId');
  if (!cfg.discord.guildId) missing.push('discord.guildId');
  if (!cfg.game.spoolDir && !cfg.game.gameRoot) {
    missing.push('game.gameRoot');
  }
  // A token that is present but obviously not a token is worth catching here:
  // discord.js reports it as "An invalid token was provided", which says nothing
  // about *which* token it tried, and the environment variable silently wins over
  // the config file.
  if (cfg.discord.token && cfg.discord.token.split('.').length !== 3) {
    throw new Error(
      'That does not look like a bot token.\n\n' +
        `  source: ${cfg.tokenSource}\n` +
        `  value:  ${describeToken(cfg.discord.token)}\n\n` +
        'A bot token is three dot-separated parts, about 70 characters.\n' +
        'Developer Portal -> your app -> Bot -> Reset Token -> Copy.',
    );
  }

  if (missing.length) {
    throw new Error(
      `Missing configuration in ${path.resolve(file)}\n\n  - ${missing.join('\n  - ')}\n\n` +
        'Open that file and fill the empty values in, then run the bot again.',
    );
  }
  return cfg;
}

/**
 * Persist a single vote setting back to config.json.
 *
 * Read-modify-write through a temp file and a rename, so an interrupted write
 * can never leave a half-written config -- that file holds the bot token, and
 * losing it to a crash mid-save would be a miserable way to find out.
 */
export async function saveVoteSetting<K extends keyof BotConfig['vote']>(
  file: string,
  key: K,
  value: BotConfig['vote'][K],
): Promise<void> {
  const raw = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const vote = (parsed['vote'] as Record<string, unknown> | undefined) ?? {};
  vote[key as string] = value;
  parsed['vote'] = vote;

  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

export function resolveSpoolDir(cfg: BotConfig): string {
  if (cfg.game.spoolDir) return path.resolve(cfg.game.spoolDir);
  return path.join(path.resolve(cfg.game.gameRoot!), 'appdata', 'chaos');
}

/** Describe a token without printing it: enough to recognise, not enough to use. */
function describeToken(token: string): string {
  if (token.length <= 12) return JSON.stringify(token);
  return `${JSON.stringify(token.slice(0, 6) + '...' + token.slice(-4))} (${token.length} chars)`;
}
