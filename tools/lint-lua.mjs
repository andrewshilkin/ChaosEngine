#!/usr/bin/env node
/**
 * Parse every .script file in the game mods with a Lua 5.1 parser.
 *
 * X-Ray reports a syntax error as a crash at game start with little context, so
 * catching them here saves a lot of alt-tabbing.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import luaparse from 'luaparse';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapters');

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith('.script')) yield full;
  }
}

let failures = 0;
let checked = 0;
for (const file of walk(root)) {
  checked++;
  const source = readFileSync(file, 'utf8');
  try {
    luaparse.parse(source, { luaVersion: '5.1' });
  } catch (err) {
    failures++;
    const rel = path.relative(process.cwd(), file);
    console.error(`${rel}: ${err.message}`);
  }
}

console.log(`${checked} Lua file(s) checked, ${failures} with syntax errors`);
process.exit(failures === 0 ? 0 : 1);
