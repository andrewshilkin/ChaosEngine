import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseGameMessage, type HostMessage } from '../protocol.js';
import { BaseTransport } from './transport.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';

export interface FileSpoolOptions {
  /** Directory holding chaos_in.jsonl / chaos_out.jsonl. */
  dir: string;
  /** How often the game's outbox is polled, in ms. */
  pollIntervalMs?: number;
  logger?: Logger;
}

const IN_FILE = 'chaos_in.jsonl';
const OUT_FILE = 'chaos_out.jsonl';

/**
 * JSON-lines spool transport.
 *
 * X-Ray's Lua sandbox has no sockets, so the game and the host talk through two
 * append-only files. Each side only appends whole lines and only consumes lines
 * terminated by a newline, which makes the channel safe without locking.
 *
 * The same design works for any game that can read and write a file, which is
 * most of them -- it is the lowest-common-denominator transport.
 */
export class FileSpoolTransport extends BaseTransport {
  readonly endpoint: string;

  private readonly dir: string;
  private readonly inPath: string;
  private readonly outPath: string;
  private readonly pollIntervalMs: number;
  private readonly log: Logger;

  private offset = 0;
  private mtimeMs = 0;
  private carry = '';
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: FileSpoolOptions) {
    super();
    this.dir = path.resolve(opts.dir);
    this.inPath = path.join(this.dir, IN_FILE);
    this.outPath = path.join(this.dir, OUT_FILE);
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
    this.log = (opts.logger ?? silentLogger).child('spool');
    this.endpoint = this.dir;
  }

  /**
   * Best guess at where Anomaly keeps its appdata spool, used as the default
   * when no directory is configured.
   */
  static defaultAnomalyDir(gameRoot?: string): string {
    if (gameRoot) return path.join(gameRoot, 'appdata', 'chaos');
    return path.join(os.homedir(), 'Anomaly', 'appdata', 'chaos');
  }

  async start(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });

    // Start both spools from empty. The command file so the game never replays
    // a backlog, and the result file so *we* never replay one: a leftover
    // chaos_out.jsonl from a previous game session still contains a `hello`
    // with its event list, which would otherwise be read as a live game.
    //
    // Truncating the result file is safe while a game is running: the game
    // appends with "a" and keeps no write offset of its own, and start() below
    // asks it to describe itself again.
    await fs.writeFile(this.inPath, '');
    await fs.writeFile(this.outPath, '');

    this.offset = 0;
    this.carry = '';
    this.mtimeMs = 0;

    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    this.log.info(`spool ready at ${this.dir}`);
    await this.poll();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.writeChain;
  }

  async send(msg: HostMessage): Promise<void> {
    const line = JSON.stringify(msg) + '\n';
    // Serialise appends so two concurrent sends cannot interleave inside a line.
    this.writeChain = this.writeChain.then(() => fs.appendFile(this.inPath, line, 'utf8'));
    await this.writeChain;
  }

  private async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      let size: number;
      let mtimeMs: number;
      try {
        const stat = await fs.stat(this.outPath);
        size = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {
        // The game has not started yet.
        this.checkStale();
        return;
      }

      if (size < this.offset) {
        // The game restarted and truncated its outbox.
        this.log.debug('outbox truncated, resetting offset');
        this.offset = 0;
        this.carry = '';
      } else if (size === this.offset && this.offset > 0 && mtimeMs > this.mtimeMs) {
        // Same size, but the file changed: the game truncated and rewrote it,
        // and the new session's output happens to be exactly as long as what we
        // had already read. Size alone cannot see this, and treating it as "no
        // new data" leaves the transport permanently deaf to a running game.
        this.log.debug('outbox rewritten at the same length, resyncing');
        this.offset = 0;
        this.carry = '';
      }

      this.mtimeMs = mtimeMs;

      if (size === this.offset) {
        this.checkStale();
        return;
      }

      const chunk = await this.readRange(this.offset, size);

      // The game truncates its outbox when it starts a new session (a save
      // load, a level change). If that happened between the stat above and the
      // read just now, `chunk` is a slice of the *new* file read at the old
      // file's offsets: garbage that arrives as half a line. Re-check, and if
      // the file shrank under us, throw the read away and start over.
      const sizeNow = (await fs.stat(this.outPath)).size;
      if (sizeNow < size) {
        this.log.debug('outbox truncated mid-read, resyncing');
        this.offset = 0;
        this.carry = '';
        return;
      }
      this.offset = size;

      const text = this.carry + chunk;
      const lines = text.split('\n');
      // A trailing fragment (no newline yet) is kept for the next poll.
      this.carry = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // A line that will not parse means we are reading from the wrong
          // offset, not that the game emitted bad JSON. Drop any partial tail
          // so the next poll starts clean rather than gluing more onto it.
          this.log.warn(`discarding malformed line, resyncing: ${trimmed.slice(0, 80)}`);
          this.carry = '';
          continue;
        }
        const msg = parseGameMessage(parsed);
        if (!msg) {
          this.log.warn('discarding message with unexpected shape');
          continue;
        }
        this.emitMessage(msg);
      }
    } catch (err) {
      this.log.error(`poll failed: ${String(err)}`);
    } finally {
      this.reading = false;
    }
  }

  private readRange(start: number, end: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      createReadStream(this.outPath, { start, end: end - 1 })
        .on('data', (c) => chunks.push(c as Buffer))
        .on('error', reject)
        .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }
}
