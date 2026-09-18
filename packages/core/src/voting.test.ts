import assert from 'node:assert/strict';
import test from 'node:test';

import { Vote } from './voting.js';

const OPTIONS = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
  { id: 'c', label: 'C' },
];

test('one vote per voter, changeable', () => {
  const vote = new Vote(OPTIONS, 10);
  assert.equal(vote.cast('u1', 'a'), 'added');
  assert.equal(vote.cast('u1', 'a'), 'unchanged');
  assert.equal(vote.cast('u1', 'b'), 'changed');
  assert.equal(vote.voterCount, 1);
  assert.deepEqual(vote.counts(), [0, 1, 0]);
});

test('unknown options are rejected', () => {
  const vote = new Vote(OPTIONS, 10);
  assert.equal(vote.cast('u1', 'nope'), 'rejected');
  assert.equal(vote.voterCount, 0);
});

test('percentages are of voters, not options', () => {
  const vote = new Vote(OPTIONS, 10);
  vote.cast('u1', 'a');
  vote.cast('u2', 'a');
  vote.cast('u3', 'b');
  const tally = vote.tally();
  assert.equal(tally[0]!.percent, 67);
  assert.equal(tally[1]!.percent, 33);
  assert.equal(tally[2]!.percent, 0);
});

test('a tie goes to whichever option got there first', () => {
  let clock = 1000;
  const vote = new Vote(OPTIONS, 10, () => clock);
  vote.cast('u1', 'b');
  clock += 500;
  vote.cast('u2', 'a');
  const result = vote.close();
  assert.equal(result.winner.id, 'b');
});

test('no votes falls back to the first option', () => {
  const vote = new Vote(OPTIONS, 10);
  const result = vote.close();
  assert.equal(result.winner.id, 'a');
  assert.equal(result.unvoted, true);
});

test('a closed vote takes no more ballots', () => {
  const vote = new Vote(OPTIONS, 10);
  vote.close();
  assert.equal(vote.cast('u1', 'a'), 'rejected');
});

test('needs at least two options', () => {
  assert.throws(() => new Vote([{ id: 'a', label: 'A' }], 10));
});
