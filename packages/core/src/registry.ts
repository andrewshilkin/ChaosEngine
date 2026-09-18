import type { GameEventDescriptor } from './protocol.js';

/**
 * Optional per-event overrides loaded from a data file (see
 * adapters/<game>/events.json). The game is the source of truth for what
 * *exists*; the manifest is the source of truth for how it is *presented and
 * balanced*, so a community can retune the mod without touching game code.
 */
export interface EventOverride {
  id: string;
  name?: string;
  category?: string;
  cooldown?: number;
  weight?: number;
  /** Default parameters sent with the event unless the caller overrides them. */
  parameters?: Record<string, number | string | boolean>;
  /** Set false to hide the event from ballots entirely. */
  enabled?: boolean;
}

export interface EventManifest {
  game: string;
  events: EventOverride[];
}

export interface RegistryEntry extends GameEventDescriptor {
  enabled: boolean;
  defaultParameters: Record<string, number | string | boolean>;
}

/**
 * Holds what the connected game says it can do, with manifest overrides applied.
 * Game-agnostic: it never inspects ids or categories for meaning.
 */
export class EventRegistry {
  private entries = new Map<string, RegistryEntry>();
  private overrides = new Map<string, EventOverride>();

  applyManifest(manifest: EventManifest | null): void {
    this.overrides.clear();
    for (const o of manifest?.events ?? []) {
      this.overrides.set(o.id, o);
    }
    // Re-apply to anything already known.
    const current = [...this.entries.values()];
    this.entries.clear();
    this.replaceAll(current);
  }

  replaceAll(descriptors: GameEventDescriptor[]): void {
    this.entries.clear();
    for (const d of descriptors) {
      const o = this.overrides.get(d.id);
      this.entries.set(d.id, {
        ...d,
        name: o?.name ?? d.name,
        category: o?.category ?? d.category,
        cooldown: o?.cooldown ?? d.cooldown,
        weight: o?.weight ?? d.weight,
        enabled: o?.enabled ?? true,
        defaultParameters: { ...defaultsFromSpec(d), ...(o?.parameters ?? {}) },
      });
    }
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  all(): RegistryEntry[] {
    return [...this.entries.values()];
  }

  enabled(): RegistryEntry[] {
    return this.all().filter((e) => e.enabled);
  }

  categories(): string[] {
    return [...new Set(this.all().map((e) => e.category))].sort();
  }

  get size(): number {
    return this.entries.size;
  }
}

function defaultsFromSpec(d: GameEventDescriptor): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const [key, spec] of Object.entries(d.params ?? {})) {
    if (spec && spec.default !== undefined) out[key] = spec.default;
  }
  return out;
}
