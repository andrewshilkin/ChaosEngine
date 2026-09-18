#!/usr/bin/env node
/**
 * Offline test client.
 *
 * Everything the Discord bot can do, minus Discord -- this is how the pipeline
 * is verified before a token is ever involved (step 8 of the development plan).
 *
 *   chaos status
 *   chaos list
 *   chaos fire spawn_bloodsucker count=5
 *   chaos notify "hello from the outside"
 *   chaos vote --duration 15 --voters 12
 *   chaos reset
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ChaosEngine } from './engine.js';
import { createLogger, type LogLevel } from './logger.js';
import { loadManifest } from './manifest.js';
import { FileSpoolTransport } from './transport/file-spool.js';

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags.set(token.slice(2), next);
          i++;
        } else {
          flags.set(token.slice(2), 'true');
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { command: positional.shift() ?? 'help', positional, flags };
}

function resolveSpoolDir(flags: Map<string, string>): string {
  const explicit = flags.get('dir') ?? process.env['CHAOS_SPOOL_DIR'];
  if (explicit) return path.resolve(explicit);
  const gameRoot = flags.get('game-root') ?? process.env['ANOMALY_DIR'];
  if (gameRoot) return path.join(path.resolve(gameRoot), 'appdata', 'chaos');
  throw new Error(
    'No spool directory. Pass --dir <path>, or --game-root <Anomaly folder>, ' +
      'or set CHAOS_SPOOL_DIR / ANOMALY_DIR.',
  );
}

function parseParams(tokens: string[]): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    const raw = token.slice(eq + 1);
    if (raw === 'true' || raw === 'false') out[key] = raw === 'true';
    else if (raw !== '' && !Number.isNaN(Number(raw))) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

const USAGE = `chaos <command> [options]

Commands:
  status                       show connection state and active events
  list                         list the events the game reports
  fire <id> [key=value ...]    run one event
  notify <text>                show a message in game
  vote [--duration n] [--voters n] [--size n]
                               run a simulated vote end to end
  reset                        clear cooldowns and active events

Options:
  --dir <path>                 spool directory (default: $CHAOS_SPOOL_DIR)
  --game-root <path>           game folder; spool is <root>/appdata/chaos
  --manifest <path>            events.json with presentation/balance overrides
  --log <level>                debug | info | warn | error   (default info)
  --wait <seconds>             how long to wait for the game  (default 10)
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || args.flags.has('help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const logger = createLogger('cli', (args.flags.get('log') as LogLevel) ?? 'info');
  const dir = resolveSpoolDir(args.flags);
  const manifestPath =
    args.flags.get('manifest') ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'adapters',
      'stalker-anomaly',
      'events.json',
    );
  const manifest = await loadManifest(manifestPath);

  const engine = new ChaosEngine({
    transport: new FileSpoolTransport({ dir, logger }),
    manifest,
    logger,
  });

  await engine.start();
  try {
    const waitSeconds = Number(args.flags.get('wait') ?? 10);
    if (args.command !== 'status') {
      const ok = await waitForGame(engine, waitSeconds);
      if (!ok) {
        logger.error(`no game responded on ${dir} within ${waitSeconds}s`);
        return 1;
      }
    }
    return await run(engine, args, logger);
  } finally {
    await engine.stop();
  }
}

async function waitForGame(engine: ChaosEngine, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (engine.connected && engine.registry.size > 0) return true;
    await sleep(250);
  }
  return engine.connected && engine.registry.size > 0;
}

async function run(engine: ChaosEngine, args: Args, logger: ReturnType<typeof createLogger>) {
  switch (args.command) {
    case 'status': {
      await sleep(1500);
      const s = engine.status();
      process.stdout.write(
        `spool:      ${s.endpoint}\n` +
          `connected:  ${s.connected}\n` +
          `last seen:  ${s.lastSeen ? new Date(s.lastSeen).toISOString() : 'never'}\n` +
          `events:     ${engine.registry.size}\n`,
      );
      return s.connected ? 0 : 1;
    }

    case 'list': {
      const rows = engine.registry.all();
      const width = Math.max(...rows.map((r) => r.id.length), 4);
      process.stdout.write(
        `${'id'.padEnd(width)}  ${'category'.padEnd(10)}  cd    w     available\n`,
      );
      for (const r of rows) {
        process.stdout.write(
          `${r.id.padEnd(width)}  ${r.category.padEnd(10)}  ${String(r.cooldown).padEnd(5)} ` +
            `${r.weight.toFixed(2)}  ${r.available ? 'yes' : 'no'}\n`,
        );
      }
      return 0;
    }

    case 'fire': {
      const id = args.positional[0];
      if (!id) {
        logger.error('usage: chaos fire <event_id> [key=value ...]');
        return 2;
      }
      const result = await engine.execute(id, parseParams(args.positional.slice(1)));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.success ? 0 : 1;
    }

    case 'notify': {
      const text = args.positional.join(' ');
      if (!text) {
        logger.error('usage: chaos notify <text>');
        return 2;
      }
      await engine.notify(text);
      return 0;
    }

    case 'reset': {
      await engine.reset();
      logger.info('reset sent');
      return 0;
    }

    case 'vote': {
      const duration = Number(args.flags.get('duration') ?? 15);
      const voters = Number(args.flags.get('voters') ?? 10);
      const size = Number(args.flags.get('size') ?? 4);

      const options = engine.ballot({ size });
      if (options.length < 2) {
        logger.error('not enough available events to build a ballot');
        return 1;
      }

      logger.info(`ballot: ${options.map((o) => o.label).join(', ')}`);
      const done = new Promise<number>((resolve) => {
        engine.onVoteCompleted(({ result, execution }) => {
          process.stdout.write('\nResult:\n');
          for (const row of result.tally) {
            process.stdout.write(
              `  ${row.option.label.padEnd(20)} ${String(row.votes).padStart(3)}  ${row.percent}%\n`,
            );
          }
          process.stdout.write(`  winner: ${result.winner.label}\n`);
          process.stdout.write(`  executed: ${JSON.stringify(execution)}\n`);
          resolve(execution?.success ? 0 : 1);
        });
      });

      engine.startVote(options, duration);

      // Simulated voters trickling in over the first two thirds of the vote.
      for (let i = 0; i < voters; i++) {
        const delay = Math.random() * duration * 1000 * 0.66;
        setTimeout(() => {
          const choice = options[Math.floor(Math.random() * options.length)]!;
          engine.voting.cast(`fake_voter_${i}`, choice.id);
        }, delay);
      }

      return await done;
    }

    default:
      process.stdout.write(USAGE);
      return 2;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
