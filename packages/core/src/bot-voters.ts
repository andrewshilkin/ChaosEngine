import type { Vote, VoteOption } from './voting.js';

export interface BotVoterOptions {
  /** How many house voters take part. 0 disables them. */
  count: number;
  /** Vote duration, so their ballots land while voting is still open. */
  durationSeconds: number;
  /**
   * Fraction of the vote during which they cast. 0.7 means they are all in by
   * the time 70% of the clock has run, leaving the tail to real voters.
   */
  spread?: number;
  random?: () => number;
}

/**
 * Adds a few automated voters to a vote.
 *
 * A vote that closes with zero ballots falls through to the tie rule and always
 * picks the first option, which makes quiet hours feel broken. House voters
 * keep something happening, and give a real voter something to react to.
 *
 * Their ballots are ordinary votes: they show up in the tally like anyone
 * else's and a human majority always overrules them.
 *
 * @returns a cancel function; call it if the vote ends early.
 */
export function addBotVoters(
  vote: Vote,
  options: VoteOption[],
  opts: BotVoterOptions,
): () => void {
  const { count, durationSeconds } = opts;
  const spread = opts.spread ?? 0.7;
  const random = opts.random ?? Math.random;

  if (count <= 0 || options.length === 0) return () => {};

  const timers: NodeJS.Timeout[] = [];
  for (let i = 0; i < count; i++) {
    const delay = random() * durationSeconds * 1000 * spread;
    timers.push(
      setTimeout(() => {
        if (vote.isClosed) return;
        const choice = options[Math.floor(random() * options.length)];
        if (choice) vote.cast(`bot:${i}`, choice.id);
      }, delay),
    );
  }

  return () => {
    for (const t of timers) clearTimeout(t);
  };
}
