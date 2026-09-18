import { promises as fs } from 'node:fs';

import type { EventManifest, EventOverride } from './registry.js';

/**
 * Load an adapter's events.json. Missing file is not an error -- the game's own
 * descriptors are always sufficient; the manifest only tunes presentation and
 * balance.
 */
export async function loadManifest(file: string): Promise<EventManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${file}: manifest must be an object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['game'] !== 'string') {
    throw new Error(`${file}: manifest needs a "game" field`);
  }
  if (!Array.isArray(obj['events'])) {
    throw new Error(`${file}: manifest needs an "events" array`);
  }

  const events: EventOverride[] = [];
  for (const entry of obj['events'] as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e['id'] !== 'string') continue;
    events.push({
      id: e['id'],
      ...(typeof e['name'] === 'string' ? { name: e['name'] } : {}),
      ...(typeof e['category'] === 'string' ? { category: e['category'] } : {}),
      ...(typeof e['cooldown'] === 'number' ? { cooldown: e['cooldown'] } : {}),
      ...(typeof e['weight'] === 'number' ? { weight: e['weight'] } : {}),
      ...(typeof e['enabled'] === 'boolean' ? { enabled: e['enabled'] } : {}),
      ...(typeof e['parameters'] === 'object' && e['parameters'] !== null
        ? { parameters: e['parameters'] as Record<string, number | string | boolean> }
        : {}),
    });
  }

  return { game: obj['game'], events };
}
