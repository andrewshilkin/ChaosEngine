#!/usr/bin/env node
/**
 * Copy the game mod into an Anomaly install (or any game root with a gamedata
 * folder), and print the spool directory the host should be pointed at.
 *
 *   npm run install-mod -- --game-root "C:/Games/Anomaly"
 *   npm run install-mod -- --game-root "C:/Games/Anomaly" --link    (junction)
 *
 * With --link the mod's scripts folder is symlinked instead of copied, so
 * editing a .script file takes effect on the next game start with no re-copy.
 * Windows may require an elevated shell for that.
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modRoot = path.join(here, '..', 'adapters', 'stalker-anomaly', 'game-mod', 'gamedata');

const args = process.argv.slice(2);
let gameRoot = process.env.ANOMALY_DIR;
let link = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--game-root') gameRoot = args[i + 1];
  if (args[i] === '--link') link = true;
}

if (!gameRoot) {
  console.error('usage: install-mod --game-root <Anomaly folder> [--link]   (or set ANOMALY_DIR)');
  process.exit(2);
}
gameRoot = path.resolve(gameRoot);

if (!existsSync(path.join(gameRoot, 'bin'))) {
  console.error(`${gameRoot} does not look like a game install (no bin\\ folder).`);
  process.exit(1);
}

const target = path.join(gameRoot, 'gamedata');

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

if (link) {
  const src = path.join(modRoot, 'scripts');
  const dst = path.join(target, 'scripts');
  if (existsSync(dst)) {
    const stat = statSync(dst);
    if (stat.isSymbolicLink() || readdirSync(dst).length === 0) rmSync(dst, { recursive: true, force: true });
    else {
      console.error(`${dst} already exists and is not empty; refusing to replace it with a link.`);
      console.error('Install without --link, or move the existing scripts folder aside first.');
      process.exit(1);
    }
  }
  mkdirSync(target, { recursive: true });
  symlinkSync(src, dst, 'junction');
  console.log(`linked ${dst} -> ${src}`);
} else {
  console.log(`installing into ${target}`);
  copyTree(modRoot, target);
}

// Lua's io.open cannot create directories and the engine's writer does not
// either, so the spool folder has to exist before the mod can use it.
const spool = path.join(gameRoot, 'appdata', 'chaos');
mkdirSync(spool, { recursive: true });
console.log('');
console.log(`spool directory ready: ${spool}`);
console.log('');
console.log('Next:');
console.log('  1. start Anomaly and load a save');
console.log('  2. check for "Mod loaded" in appdata\\chaos.log');
console.log(`  3. npm run chaos -- --game-root "${gameRoot}" status`);
