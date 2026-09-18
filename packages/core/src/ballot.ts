import type { CooldownManager } from './cooldown.js';
import type { EventRegistry, RegistryEntry } from './registry.js';
import type { VoteOption } from './voting.js';

export interface BallotOptions {
  /** How many choices to offer. */
  size?: number;
  /**
   * How the choices are picked.
   *
   *   groups  one option per category first, so a ballot spans different kinds
   *           of event (a monster, some loot, a world change...). Falls back to
   *           filling the remaining slots once categories run out.
   *   flat    weighted across everything, capped per category.
   */
  strategy?: 'groups' | 'flat';
  /** Cap used by the `flat` strategy and by the fill-up pass. */
  maxPerCategory?: number;
  /** Only consider these categories. */
  categories?: string[];
  /**
   * Events to keep off this ballot if at all possible -- typically the ones
   * offered in the last couple of votes. Weighting alone is not enough: in a
   * category of three, the heaviest option still wins most rounds, and a
   * community that sees "Nightfall" five votes running stops reading the
   * buttons. These are only used if there is nothing else left to offer.
   */
  avoid?: Iterable<string>;
  /** Random source, injectable for tests. */
  random?: () => number;
}

/**
 * Build the list of choices for one vote: weighted, without repeats, skipping
 * anything disabled, on cooldown, or that the game reported as unavailable.
 *
 * Game-agnostic. "Category" is whatever string the game adapter put on its
 * events; this code never looks at the values.
 */
export function buildBallot(
  registry: EventRegistry,
  cooldowns: CooldownManager,
  opts: BallotOptions = {},
): VoteOption[] {
  const size = opts.size ?? 4;
  const strategy = opts.strategy ?? 'groups';
  const maxPerCategory = opts.maxPerCategory ?? Math.max(1, Math.ceil(size / 2));
  const random = opts.random ?? Math.random;

  let pool = registry.enabled().filter((e) => e.available && cooldowns.ready(e.id));
  if (opts.categories?.length) {
    const wanted = new Set(opts.categories);
    pool = pool.filter((e) => wanted.has(e.category));
  }

  // Prefer a pool with the recently-offered events removed, but never let that
  // shrink the ballot: a small event set would otherwise produce two options.
  const avoid = new Set(opts.avoid ?? []);
  const fresh = avoid.size > 0 ? pool.filter((e) => !avoid.has(e.id)) : pool;

  const pick = (from: RegistryEntry[]) =>
    strategy === 'groups'
      ? pickAcrossGroups(from, size, maxPerCategory, random)
      : pickFlat(from, size, maxPerCategory, random);

  let chosen = pick(fresh);
  if (chosen.length < size && fresh.length < pool.length) {
    chosen = pick(pool);
  }

  return chosen.map((e) => ({
    id: e.id,
    label: e.name,
    parameters: e.defaultParameters,
  }));
}

/**
 * One option per category, categories visited in random order, the event
 * within a category chosen by weight. Any slots left over once every category
 * has contributed are filled from what remains.
 */
function pickAcrossGroups(
  pool: RegistryEntry[],
  size: number,
  maxPerCategory: number,
  random: () => number,
): RegistryEntry[] {
  const byCategory = new Map<string, RegistryEntry[]>();
  for (const entry of pool) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  const chosen: RegistryEntry[] = [];
  const taken = new Set<RegistryEntry>();

  for (const category of shuffle([...byCategory.keys()], random)) {
    if (chosen.length >= size) break;
    const picked = weightedPick(byCategory.get(category)!, random);
    if (picked) {
      chosen.push(picked);
      taken.add(picked);
    }
  }

  // Fewer categories than slots: top up, still avoiding a category landslide.
  if (chosen.length < size) {
    const perCategory = new Map<string, number>();
    for (const entry of chosen) {
      perCategory.set(entry.category, (perCategory.get(entry.category) ?? 0) + 1);
    }
    let remaining = pool.filter((e) => !taken.has(e));
    while (chosen.length < size && remaining.length > 0) {
      const eligible = remaining.filter(
        (e) => (perCategory.get(e.category) ?? 0) < maxPerCategory,
      );
      const picked = weightedPick(eligible.length > 0 ? eligible : remaining, random);
      if (!picked) break;
      chosen.push(picked);
      perCategory.set(picked.category, (perCategory.get(picked.category) ?? 0) + 1);
      remaining = remaining.filter((e) => e !== picked);
    }
  }

  return chosen;
}

function pickFlat(
  pool: RegistryEntry[],
  size: number,
  maxPerCategory: number,
  random: () => number,
): RegistryEntry[] {
  const chosen: RegistryEntry[] = [];
  const perCategory = new Map<string, number>();

  // Two passes: the first respects the per-category cap, the second fills any
  // remaining slots so a small pool still produces a usable ballot.
  for (const respectCap of [true, false]) {
    let candidates = pool.filter((e) => !chosen.includes(e));
    while (chosen.length < size && candidates.length > 0) {
      const eligible = respectCap
        ? candidates.filter((e) => (perCategory.get(e.category) ?? 0) < maxPerCategory)
        : candidates;
      if (eligible.length === 0) break;

      const picked = weightedPick(eligible, random);
      if (!picked) break;
      chosen.push(picked);
      perCategory.set(picked.category, (perCategory.get(picked.category) ?? 0) + 1);
      candidates = candidates.filter((e) => e !== picked);
    }
    if (chosen.length >= size) break;
  }

  return chosen;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function weightedPick(entries: RegistryEntry[], random: () => number): RegistryEntry | undefined {
  if (entries.length === 0) return undefined;
  const total = entries.reduce((sum, e) => sum + Math.max(0, e.weight), 0);
  if (total <= 0) return entries[Math.floor(random() * entries.length)] ?? entries[0];
  let roll = random() * total;
  for (const e of entries) {
    roll -= Math.max(0, e.weight);
    if (roll <= 0) return e;
  }
  return entries[entries.length - 1];
}
