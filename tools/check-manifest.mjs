#!/usr/bin/env node
/**
 * Keep events.json and the mod in step.
 *
 * The manifest only retunes events the game already has, so an id in one and
 * not the other is silent: a stale entry does nothing, and a missing one just
 * means that event never gets its display name or weight. Neither fails
 * loudly, which is exactly why this check exists.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapters');
const adapters = [
  {
    name: 'stalker-anomaly',
    script: path.join(root, 'stalker-anomaly/game-mod/gamedata/scripts/chaos_game_events.script'),
    manifest: path.join(root, 'stalker-anomaly/events.json'),
    // Lua:  id = "spawn_dogs",
    idPattern: /\bid\s*=\s*"([a-z0-9_]+)"/g,
  },
  {
    name: 'gta4',
    script: path.join(root, 'gta4/game-mod/ChaosEngine.cs'),
    manifest: path.join(root, 'gta4/events.json'),
    // C#:  something.Id = "wanted";
    idPattern: /\.Id\s*=\s*"([a-z0-9_]+)"/g,
  },
];

let failures = 0;
for (const adapter of adapters) {
  const source = readFileSync(adapter.script, 'utf8');
  const manifest = JSON.parse(readFileSync(adapter.manifest, 'utf8'));

  const inMod = new Set([...source.matchAll(adapter.idPattern)].map((m) => m[1]));
  const inManifest = new Set(manifest.events.map((e) => e.id));

  const missing = [...inMod].filter((id) => !inManifest.has(id));
  const stale = [...inManifest].filter((id) => !inMod.has(id));

  if (missing.length || stale.length) {
    failures++;
    console.error(`${adapter.name}:`);
    if (missing.length) console.error(`  not in events.json: ${missing.join(', ')}`);
    if (stale.length) console.error(`  no longer in the mod: ${stale.join(', ')}`);
  } else {
    console.log(`${adapter.name}: ${inMod.size} events, manifest in step`);
  }
}
process.exit(failures === 0 ? 0 : 1);
