#!/usr/bin/env node
/**
 * Run the game mod's Lua headlessly against stubbed X-Ray APIs.
 *
 * The point is to make a broken mod fail here, in a second, instead of after a
 * three-minute game load. It cannot reproduce engine crashes, but it catches
 * everything that lives in the Lua itself.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { lua, lauxlib, lualib, to_luastring } from 'fengari';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(
  here, '..', '..', 'adapters', 'stalker-anomaly', 'game-mod', 'gamedata', 'scripts',
);

// Load order mirrors what X-Ray guarantees: every file is loaded before any
// on_game_start runs, so cross-references inside functions are always fine.
const ORDER = [
  'chaos_rt_json',
  'chaos_rt_log',
  'chaos_rt_manager',
  'chaos_rt_ui',
  'chaos_rt_ipc',
  'chaos_game_events',
  'chaos_boot',
];

function luaLongString(source) {
  let eq = '=';
  while (source.includes(`]${eq}]`)) eq += '=';
  return `[${eq}[\n${source}\n]${eq}]`;
}

const sources = ORDER.map(
  (name) => `  ${name} = ${luaLongString(readFileSync(path.join(scriptsDir, `${name}.script`), 'utf8'))},`,
).join('\n');

const bootstrap = `
local SOURCES = {
${sources}
}
local ORDER = { ${ORDER.map((n) => `"${n}"`).join(', ')} }
HARNESS.load_scripts(SOURCES, ORDER)
`;

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

function run(chunk, name) {
  const status = lauxlib.luaL_loadbuffer(L, to_luastring(chunk), null, to_luastring(name));
  if (status !== lua.LUA_OK || lua.lua_pcall(L, 0, lua.LUA_MULTRET, 0) !== lua.LUA_OK) {
    const err = lua.lua_tojsstring(L, -1);
    console.error(`${name}: ${err}`);
    process.exit(1);
  }
}

run(readFileSync(path.join(here, 'xray-stubs.lua'), 'utf8'), 'xray-stubs.lua');
run(bootstrap, 'bootstrap');
run(readFileSync(path.join(here, 'scenario.lua'), 'utf8'), 'scenario.lua');

lua.lua_getglobal(L, to_luastring('HARNESS'));
lua.lua_getfield(L, -1, to_luastring('failures'));
const failures = lua.lua_tointeger(L, -1);
process.exit(failures === 0 ? 0 : 1);
