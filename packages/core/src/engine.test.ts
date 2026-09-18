import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ChaosEngine } from './engine.js';
import { silentLogger } from './logger.js';
import { FileSpoolTransport } from './transport/file-spool.js';
import { MockGame } from './testing/mock-game.js';

async function scratchDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'chaos-spool-'));
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function harness() {
  const dir = await scratchDir();
  const game = new MockGame({ dir, pollIntervalMs: 25, heartbeatMs: 500 });
  const engine = new ChaosEngine({
    transport: new FileSpoolTransport({ dir, pollIntervalMs: 25, logger: silentLogger }),
    logger: silentLogger,
  });
  await game.start();
  await engine.start();
  await waitFor(() => engine.connected && engine.registry.size > 0);
  return {
    dir,
    game,
    engine,
    async dispose() {
      await engine.stop();
      await game.stop();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('the engine learns the game event list over the spool', async () => {
  const h = await harness();
  try {
    assert.ok(h.engine.registry.size >= 5);
    assert.ok(h.engine.registry.has('spawn_bloodsucker'));
  } finally {
    await h.dispose();
  }
});

test('executing an event reaches the game with merged default parameters', async () => {
  const h = await harness();
  try {
    const result = await h.engine.execute('spawn_bloodsucker');
    assert.equal(result.success, true);
    assert.equal(h.game.executed.length, 1);
    assert.deepEqual(h.game.executed[0]?.parameters, { count: 3 });
  } finally {
    await h.dispose();
  }
});

test('explicit parameters win over the defaults', async () => {
  const h = await harness();
  try {
    await h.engine.execute('spawn_zombies', { count: 15 });
    assert.deepEqual(h.game.executed[0]?.parameters, { count: 15 });
  } finally {
    await h.dispose();
  }
});

test('an unknown event never reaches the game', async () => {
  const h = await harness();
  try {
    const result = await h.engine.execute('rm_minus_rf');
    assert.equal(result.success, false);
    assert.equal(result.error, 'unknown_event');
    assert.equal(h.game.executed.length, 0);
  } finally {
    await h.dispose();
  }
});

test('a second run while on cooldown is refused and mirrored host-side', async () => {
  const h = await harness();
  try {
    await h.engine.execute('heal_player');
    const second = await h.engine.execute('heal_player');
    assert.equal(second.success, false);
    assert.equal(second.error, 'on_cooldown');
    assert.ok(h.engine.cooldowns.remaining('heal_player') > 0);
    assert.equal(h.engine.ballot({ size: 5 }).some((o) => o.id === 'heal_player'), false);
  } finally {
    await h.dispose();
  }
});

test('a full vote runs the winner and mirrors the board into the game', async () => {
  const h = await harness();
  try {
    const options = h.engine.ballot({ size: 3 });
    assert.ok(options.length >= 2);

    const completed = new Promise<void>((resolve) => {
      h.engine.onVoteCompleted(({ result, execution }) => {
        assert.equal(result.winner.id, options[0]!.id);
        assert.equal(execution?.success, true);
        resolve();
      });
    });

    h.engine.startVote(options, 1);
    h.engine.voting.cast('voter-1', options[0]!.id);
    h.engine.voting.cast('voter-2', options[0]!.id);

    await waitFor(() => h.game.received.includes('vote_start'));
    await new Promise((r) => setTimeout(r, 1200));
    h.engine.voting.finish();
    await completed;

    assert.ok(h.game.received.includes('vote_end'));
    assert.equal(h.game.executed.at(-1)?.id, options[0]!.id);
  } finally {
    await h.dispose();
  }
});

test('the transport survives a game restart that truncates the spool', async () => {
  const h = await harness();
  try {
    await h.game.stop();
    await h.game.start(); // truncates chaos_out.jsonl and says hello again
    await waitFor(() => h.engine.registry.size > 0);
    const result = await h.engine.execute('give_random_weapon');
    assert.equal(result.success, true);
  } finally {
    await h.dispose();
  }
});

test('a stale spool from a previous game session is not read as a live game', async () => {
  const dir = await scratchDir();
  try {
    // What Anomaly leaves behind after it exits: a full session, hello included.
    await fs.writeFile(
      path.join(dir, 'chaos_out.jsonl'),
      JSON.stringify({
        protocol: 1,
        game: 'stalker-anomaly',
        type: 'hello',
        events: [
          {
            id: 'ghost_event',
            name: 'Ghost',
            category: 'mutants',
            duration: 0,
            cooldown: 0,
            weight: 1,
            params: {},
            available: true,
          },
        ],
      }) + '\n' +
        JSON.stringify({ protocol: 1, game: 'stalker-anomaly', type: 'goodbye' }) + '\n',
    );

    const engine = new ChaosEngine({
      transport: new FileSpoolTransport({ dir, pollIntervalMs: 25, logger: silentLogger }),
      logger: silentLogger,
      requestTimeoutMs: 300,
    });
    await engine.start();
    try {
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(engine.connected, false, 'a dead session must not count as connected');
      assert.equal(engine.registry.has('ghost_event'), false);
    } finally {
      await engine.stop();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a game that was already running is picked up without waiting for hello', async () => {
  const dir = await scratchDir();
  const game = new MockGame({ dir, pollIntervalMs: 25, heartbeatMs: 500 });
  await game.start();

  const engine = new ChaosEngine({
    transport: new FileSpoolTransport({ dir, pollIntervalMs: 25, logger: silentLogger }),
    logger: silentLogger,
  });
  // The engine starts second, so the mock's hello is already gone from the spool.
  await engine.start();
  try {
    await waitFor(() => engine.registry.size > 0);
    assert.ok(engine.registry.has('spawn_bloodsucker'));
    assert.equal(engine.connected, true);
  } finally {
    await engine.stop();
    await game.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a game restart that truncates the spool mid-read does not corrupt the stream', async () => {
  const dir = await scratchDir();
  const out = path.join(dir, 'chaos_out.jsonl');

  const helloFor = (ids: string[]) =>
    JSON.stringify({
      protocol: 1,
      game: 'stalker-anomaly',
      type: 'hello',
      events: ids.map((id) => ({
        id,
        name: id,
        category: 'mutants',
        duration: 0,
        cooldown: 0,
        weight: 1,
        params: {},
        available: true,
      })),
    }) + '\n';

  // A long-running previous session, then the file is replaced by a new one.
  await fs.writeFile(
    out,
    helloFor(['old_a', 'old_b']) +
      Array.from({ length: 200 }, () =>
        JSON.stringify({ protocol: 1, game: 'stalker-anomaly', type: 'heartbeat', active: [], online: true }),
      ).join('\n') +
      '\n',
  );

  const engine = new ChaosEngine({
    transport: new FileSpoolTransport({ dir, pollIntervalMs: 20, logger: silentLogger }),
    logger: silentLogger,
    requestTimeoutMs: 300,
  });
  await engine.start();
  try {
    // Hammer truncate-and-rewrite while the transport is polling, which is what
    // a save load does to the outbox.
    for (let i = 0; i < 12; i++) {
      await fs.writeFile(out, helloFor([`gen${i}_x`, `gen${i}_y`]));
      await new Promise((r) => setTimeout(r, 80));
    }
    await waitFor(
      () => engine.registry.has('gen11_x'),
      10_000,
    ).catch(() => {
      throw new Error('registry holds: ' + engine.registry.all().map((e) => e.id).join(','));
    });

    // The registry must reflect the newest session exactly, with nothing from
    // an older one left behind.
    assert.equal(engine.registry.size, 2, 'registry holds: ' + engine.registry.all().map((e) => e.id).join(','));
    assert.ok(engine.registry.has('gen11_y'));
    assert.equal(engine.registry.has('old_a'), false);
  } finally {
    await engine.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a describe answer that arrives after its timeout still updates the registry', async () => {
  const dir = await scratchDir();
  const engine = new ChaosEngine({
    transport: new FileSpoolTransport({ dir, pollIntervalMs: 20, logger: silentLogger }),
    logger: silentLogger,
    requestTimeoutMs: 100,
  });
  await engine.start();
  try {
    // No game answered the startup describe; it has long since timed out.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(engine.registry.size, 0);

    // The game unpauses and answers, with a request_id nobody is waiting for.
    await fs.appendFile(
      path.join(dir, 'chaos_out.jsonl'),
      JSON.stringify({
        protocol: 1,
        game: 'stalker-anomaly',
        type: 'events',
        request_id: 'long-forgotten',
        events: [
          {
            id: 'late_event',
            name: 'Late',
            category: 'world',
            duration: 0,
            cooldown: 0,
            weight: 1,
            params: {},
            available: true,
          },
        ],
      }) + '\n',
    );

    await waitFor(() => engine.registry.has('late_event'), 2000);
  } finally {
    await engine.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the engine stops the same events coming round every vote', async () => {
  const h = await harness();
  try {
    const first = h.engine.ballot({ size: 2 });
    const second = h.engine.ballot({ size: 2 });
    const overlap = second.filter((o) => first.some((f) => f.id === o.id));
    assert.deepEqual(overlap, [], 'consecutive ballots repeated an event');
  } finally {
    await h.dispose();
  }
});
