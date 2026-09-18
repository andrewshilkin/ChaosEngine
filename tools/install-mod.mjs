#!/usr/bin/env node
/**
 * Install a game adapter into its game, and print where the host should point.
 *
 *   npm run install-mod -- --game stalker --game-root "C:/Games/Anomaly"
 *   npm run install-mod -- --game gta4    --game-root "F:/.../GTAIV"
 *
 * With --link the source folder is junctioned instead of copied, so editing a
 * script takes effect on the next game start. Windows may want an elevated
 * shell for that.
 */
import {
  existsSync, mkdirSync, readdirSync, statSync, copyFileSync, symlinkSync, rmSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const ADAPTERS = {
  stalker: {
    id: 'stalker-anomaly',
    // Everything under game-mod/ is laid over the game root.
    from: path.join(root, 'adapters/stalker-anomaly/game-mod'),
    into: '.',
    linkable: 'gamedata/scripts',
    spool: 'appdata/chaos',
    looksRight: (dir) => existsSync(path.join(dir, 'bin')),
    hint: 'the folder containing bin\\ and gamedata\\',
    next: [
      'start Anomaly and load a save',
      'check for "Mod loaded" in appdata\\chaos.log',
    ],
  },
  gta4: {
    id: 'gta4',
    from: path.join(root, 'adapters/gta4/game-mod'),
    // The .NET Script Hook loads plain .cs files from scripts\.
    into: 'scripts',
    linkable: null,
    spool: 'scripts/chaos',
    looksRight: (dir) =>
      existsSync(path.join(dir, 'ScriptHookDotNet.asi')) || existsSync(path.join(dir, 'GTAIV.exe')),
    hint: 'the folder containing GTAIV.exe and ScriptHookDotNet.asi',
    next: [
      'start GTA IV and load into the world (not the menu)',
      'check for "registered 20 events" in scripts\\chaos.log',
      'if nothing appears, read ScriptHookDotNet.log for compile errors',
    ],
  },
};

const args = process.argv.slice(2);
let gameRoot = process.env.ANOMALY_DIR;
let which = null;
let link = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--game-root') gameRoot = args[i + 1];
  if (args[i] === '--game') which = args[i + 1];
  if (args[i] === '--link') link = true;
}

if (!which) {
  // Keeps the original single-game invocation working.
  which = 'stalker';
}
const adapter = ADAPTERS[which];
if (!adapter) {
  console.error(`unknown --game "${which}". Known: ${Object.keys(ADAPTERS).join(', ')}`);
  process.exit(2);
}
if (!gameRoot) {
  console.error(`usage: install-mod --game ${Object.keys(ADAPTERS).join('|')} --game-root <game folder> [--link]`);
  process.exit(2);
}
gameRoot = path.resolve(gameRoot);

if (!adapter.looksRight(gameRoot)) {
  console.error(`${gameRoot} does not look like a ${which} install.`);
  console.error(`Expected ${adapter.hint}.`);
  process.exit(1);
}

const target = path.resolve(gameRoot, adapter.into);

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = path.join(from, entry);
    const dst = path.join(to, entry);
    if (statSync(src).isDirectory()) copyTree(src, dst);
    else {
      copyFileSync(src, dst);
      console.log(`  ${path.relative(gameRoot, dst)}`);
    }
  }
}

if (link && adapter.linkable) {
  const src = path.join(adapter.from, adapter.linkable);
  const dst = path.join(gameRoot, adapter.linkable);
  if (existsSync(dst)) {
    const stat = statSync(dst);
    if (stat.isSymbolicLink() || readdirSync(dst).length === 0) {
      rmSync(dst, { recursive: true, force: true });
    } else {
      console.error(`${dst} already exists and is not empty; refusing to replace it with a link.`);
      process.exit(1);
    }
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  symlinkSync(src, dst, 'junction');
  console.log(`linked ${dst} -> ${src}`);
} else {
  if (link) console.log(`--link is not supported for ${which}, copying instead`);
  console.log(`installing into ${target}`);
  copyTree(adapter.from, target);
}

// The host creates this too, but doing it here means the game finds it on the
// very first run rather than retrying until the bot has been started once.
const spool = path.join(gameRoot, adapter.spool);
mkdirSync(spool, { recursive: true });

console.log('');
console.log(`spool directory ready: ${spool}`);
console.log('');
console.log('Next:');
adapter.next.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
console.log(`  ${adapter.next.length + 1}. npm run chaos -- --dir "${spool}" status`);
