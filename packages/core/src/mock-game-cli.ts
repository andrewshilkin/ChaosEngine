#!/usr/bin/env node
/**
 * Run the mock game adapter against a spool directory.
 *
 * Lets the bot and the CLI be developed with no game running:
 *
 *   node packages/core/dist/mock-game-cli.js --dir ./tmp/spool
 *   node packages/core/dist/cli.js --dir ./tmp/spool vote
 */

import path from 'node:path';
import process from 'node:process';

import { MockGame } from './testing/mock-game.js';

const args = process.argv.slice(2);
let dir = process.env['CHAOS_SPOOL_DIR'];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir') dir = args[i + 1];
}
if (!dir) {
  console.error('usage: mock-game --dir <spool directory>   (or set CHAOS_SPOOL_DIR)');
  process.exit(2);
}

const resolved = path.resolve(dir);
const game = new MockGame({ dir: resolved });
await game.start();
console.log(`mock game running on ${resolved}`);
console.log('it answers describe/event/ping/reset and ignores the UI messages.');

const shutdown = async () => {
  await game.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
