import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbedField,
} from 'discord.js';
import type { EventResult, RegistryEntry, Vote, VoteOption, VoteResult } from '@chaos-engine/core';

export const VOTE_BUTTON_PREFIX = 'chaos:vote:';

const BAR_WIDTH = 12;
const ACCENT = 0xff7a2f;
const ACCENT_DONE = 0x4caf50;
const ACCENT_FAIL = 0xd9534f;

function bar(percent: number): string {
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, BAR_WIDTH - filled));
}

export function voteEmbed(vote: Vote): EmbedBuilder {
  const fields: APIEmbedField[] = vote.tally().map((row, i) => ({
    name: `${i + 1}. ${row.option.label}`,
    value: `\`${bar(row.percent)}\` ${row.percent}%  (${row.votes})`,
    inline: false,
  }));

  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle('DISCORD CHAOS')
    .setDescription('Choose the next event.')
    .addFields(fields)
    .setFooter({
      text:
        vote.secondsLeft() > 0
          ? `Voting ends in ${vote.secondsLeft()}s · ${vote.voterCount} voter(s)`
          : 'Voting closed',
    });
}

export function voteButtons(options: VoteOption[], disabled = false): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < options.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const option of options.slice(i, i + 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${VOTE_BUTTON_PREFIX}${option.id}`)
          .setLabel(option.label.slice(0, 80))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled),
      );
    }
    rows.push(row);
  }
  return rows;
}

export function resultEmbed(result: VoteResult, execution: EventResult | null): EmbedBuilder {
  const lines = result.tally
    .slice()
    .sort((a, b) => b.votes - a.votes)
    .map((row) => `\`${bar(row.percent)}\` ${row.percent}%  ${row.option.label}`);

  const ok = execution?.success ?? false;
  const embed = new EmbedBuilder()
    .setColor(ok ? ACCENT_DONE : ACCENT_FAIL)
    .setTitle(`Winner: ${result.winner.label}`)
    .setDescription(lines.join('\n') || 'no votes');

  if (result.unvoted) {
    embed.addFields({ name: 'Note', value: 'Nobody voted, the first option was used.' });
  }
  if (execution && !execution.success) {
    embed.addFields({
      name: 'The game refused this event',
      value: `\`${execution.error ?? 'unknown'}\`${execution.message ? ` — ${execution.message}` : ''}`,
    });
  }
  return embed;
}

export function eventListEmbed(entries: RegistryEntry[], connected: boolean): EmbedBuilder {
  const byCategory = new Map<string, RegistryEntry[]>();
  for (const e of entries) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }

  const embed = new EmbedBuilder()
    .setColor(connected ? ACCENT : ACCENT_FAIL)
    .setTitle(`Events (${entries.length})`)
    .setFooter({ text: connected ? 'game connected' : 'game not connected' });

  for (const [category, list] of [...byCategory.entries()].sort()) {
    embed.addFields({
      name: category,
      value: list
        .map((e) => `${e.available ? '•' : '×'} **${e.name}** \`${e.id}\` cd ${e.cooldown}s`)
        .join('\n')
        .slice(0, 1024),
    });
  }
  return embed;
}
