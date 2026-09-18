import assert from 'node:assert/strict';
import test from 'node:test';

import { addBotVoters } from './bot-voters.js';
import { Vote } from './voting.js';

const OPTIONS = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test('bot voters cast during the vote', async () => {
  const vote = new Vote(OPTIONS, 1);
  addBotVoters(vote, OPTIONS, { count: 2, durationSeconds: 0.2 });
  await sleep(300);
  assert.equal(vote.voterCount, 2);
});

test('a human majority still wins', async () => {
  const vote = new Vote(OPTIONS, 1);
  addBotVoters(vote, OPTIONS, { count: 2, durationSeconds: 0.1, random: () => 0 });
  await sleep(200);
  // Both bots picked option 'a'; three humans pick 'b'.
  vote.cast('h1', 'b');
  vote.cast('h2', 'b');
  vote.cast('h3', 'b');
  assert.equal(vote.close().winner.id, 'b');
});

test('zero bot voters adds nothing', async () => {
  const vote = new Vote(OPTIONS, 1);
  addBotVoters(vote, OPTIONS, { count: 0, durationSeconds: 0.1 });
  await sleep(150);
  assert.equal(vote.voterCount, 0);
});

test('cancelling stops pending bot votes', async () => {
  const vote = new Vote(OPTIONS, 5);
  const cancel = addBotVoters(vote, OPTIONS, { count: 3, durationSeconds: 4 });
  cancel();
  await sleep(150);
  assert.equal(vote.voterCount, 0);
});
