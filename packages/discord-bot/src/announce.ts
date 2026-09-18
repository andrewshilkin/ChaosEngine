/**
 * The lines the bot says when it wakes up.
 *
 * Written for this bot rather than lifted from the games, so there is nothing
 * here that belongs to anyone else.
 */
const GREETINGS = [
  'The Zone is listening.',
  'Detector is on. Something is coming.',
  'Anomaly field is live — pick your poison.',
  'Back on the frequency. Who is out there?',
  'Signal restored. The Zone has opinions to collect.',
  'Awake, wired in, and looking for trouble.',
  'Somebody has to decide what happens next. That is you.',
  'Radio check. The Zone is taking requests.',
];

export function greeting(random: () => number = Math.random): string {
  return GREETINGS[Math.floor(random() * GREETINGS.length)] ?? GREETINGS[0]!;
}
