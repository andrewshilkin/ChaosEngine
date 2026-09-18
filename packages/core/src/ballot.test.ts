import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBallot } from './ballot.js';
import { CooldownManager } from './cooldown.js';
import type { GameEventDescriptor } from './protocol.js';
import { EventRegistry } from './registry.js';

function descriptor(id: string, category: string, extra: Partial<GameEventDescriptor> = {}) {
  return {
    id,
    name: id.toUpperCase(),
    category,
    duration: 0,
    cooldown: 60,
    weight: 1,
    params: {},
    available: true,
    ...extra,
  } satisfies GameEventDescriptor;
}

function registryOf(...descriptors: GameEventDescriptor[]): EventRegistry {
  const registry = new EventRegistry();
  registry.replaceAll(descriptors);
  return registry;
}

test('builds a ballot of the requested size without repeats', () => {
  const registry = registryOf(
    descriptor('a', 'mutants'),
    descriptor('b', 'player'),
    descriptor('c', 'world'),
    descriptor('d', 'chaos'),
    descriptor('e', 'player'),
  );
  const ballot = buildBallot(registry, new CooldownManager(), { size: 4, random: () => 0.5 });
  assert.equal(ballot.length, 4);
  assert.equal(new Set(ballot.map((o) => o.id)).size, 4);
});

test('skips events the game reported as unavailable', () => {
  const registry = registryOf(
    descriptor('a', 'mutants', { available: false }),
    descriptor('b', 'player'),
    descriptor('c', 'world'),
  );
  const ballot = buildBallot(registry, new CooldownManager(), { size: 4 });
  assert.deepEqual(ballot.map((o) => o.id).sort(), ['b', 'c']);
});

test('skips events on cooldown', () => {
  const registry = registryOf(
    descriptor('a', 'mutants'),
    descriptor('b', 'player'),
    descriptor('c', 'world'),
  );
  const cooldowns = new CooldownManager();
  cooldowns.arm('a', 60);
  const ballot = buildBallot(registry, cooldowns, { size: 4 });
  assert.ok(!ballot.some((o) => o.id === 'a'));
});

test('respects the per-category cap while the pool allows it', () => {
  const registry = registryOf(
    descriptor('a', 'player'),
    descriptor('b', 'player'),
    descriptor('c', 'player'),
    descriptor('d', 'mutants'),
    descriptor('e', 'world'),
  );
  const ballot = buildBallot(registry, new CooldownManager(), {
    size: 4,
    maxPerCategory: 2,
    random: () => 0.01,
  });
  const players = ballot.filter((o) => registry.get(o.id)?.category === 'player');
  assert.ok(players.length <= 2, `expected at most 2 player events, got ${players.length}`);
  assert.equal(ballot.length, 4);
});

test('manifest overrides rename and disable events', () => {
  const registry = registryOf(descriptor('a', 'mutants'), descriptor('b', 'player'));
  registry.applyManifest({
    game: 'test',
    events: [
      { id: 'a', name: 'Renamed', weight: 5 },
      { id: 'b', enabled: false },
    ],
  });
  const ballot = buildBallot(registry, new CooldownManager(), { size: 4 });
  assert.deepEqual(ballot.map((o) => o.label), ['Renamed']);
});

test('manifest parameters become the defaults sent with the event', () => {
  const registry = registryOf(
    descriptor('a', 'mutants', {
      params: { count: { type: 'number', default: 3 } },
    }),
    descriptor('b', 'player'),
  );
  registry.applyManifest({ game: 'test', events: [{ id: 'a', parameters: { count: 9 } }] });
  const ballot = buildBallot(registry, new CooldownManager(), { size: 2 });
  const option = ballot.find((o) => o.id === 'a');
  assert.deepEqual(option?.parameters, { count: 9 });
});

test('the groups strategy spreads a ballot across categories', () => {
  const registry = registryOf(
    descriptor('a1', 'mutants'),
    descriptor('a2', 'mutants'),
    descriptor('a3', 'mutants'),
    descriptor('b1', 'loot'),
    descriptor('b2', 'loot'),
    descriptor('c1', 'world'),
    descriptor('d1', 'player'),
  );
  for (let seed = 0; seed < 50; seed++) {
    const ballot = buildBallot(registry, new CooldownManager(), { size: 4 });
    const categories = ballot.map((o) => registry.get(o.id)!.category);
    assert.equal(ballot.length, 4);
    assert.equal(new Set(categories).size, 4, `repeat category in ${categories.join(',')}`);
  }
});

test('the groups strategy tops up when there are fewer categories than slots', () => {
  const registry = registryOf(
    descriptor('a1', 'mutants'),
    descriptor('a2', 'mutants'),
    descriptor('b1', 'loot'),
    descriptor('b2', 'loot'),
  );
  const ballot = buildBallot(registry, new CooldownManager(), { size: 4 });
  assert.equal(ballot.length, 4);
  assert.equal(new Set(ballot.map((o) => o.id)).size, 4);
});

test('the flat strategy still honours the per-category cap', () => {
  const registry = registryOf(
    descriptor('a1', 'player'),
    descriptor('a2', 'player'),
    descriptor('a3', 'player'),
    descriptor('b1', 'mutants'),
    descriptor('c1', 'world'),
  );
  const ballot = buildBallot(registry, new CooldownManager(), {
    size: 4,
    strategy: 'flat',
    maxPerCategory: 2,
  });
  const players = ballot.filter((o) => registry.get(o.id)?.category === 'player');
  assert.ok(players.length <= 2, `expected at most 2 player events, got ${players.length}`);
});

test('avoid keeps recently offered events off the next ballot', () => {
  const registry = registryOf(
    descriptor('m1', 'mutants'),
    descriptor('m2', 'mutants'),
    descriptor('l1', 'loot'),
    descriptor('l2', 'loot'),
    descriptor('w1', 'world'),
    descriptor('w2', 'world'),
    descriptor('p1', 'player'),
    descriptor('p2', 'player'),
  );
  const first = buildBallot(registry, new CooldownManager(), { size: 4 });
  const second = buildBallot(registry, new CooldownManager(), {
    size: 4,
    avoid: first.map((o) => o.id),
  });
  const overlap = second.filter((o) => first.some((f) => f.id === o.id));
  assert.deepEqual(overlap, [], `second ballot repeated ${overlap.map((o) => o.id).join(',')}`);
});

test('avoid never shrinks a ballot when the pool is small', () => {
  const registry = registryOf(
    descriptor('m1', 'mutants'),
    descriptor('l1', 'loot'),
    descriptor('w1', 'world'),
    descriptor('p1', 'player'),
  );
  const all = ['m1', 'l1', 'w1', 'p1'];
  // Every event is "recently offered", but a vote still needs four options.
  const ballot = buildBallot(registry, new CooldownManager(), { size: 4, avoid: all });
  assert.equal(ballot.length, 4);
});
