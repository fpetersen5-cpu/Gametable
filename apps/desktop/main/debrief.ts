import type { CompletionClient } from '@gametable/agent';
import type { ReplayBundle } from '../shared/api.js';

/**
 * One cheap model call over the finished match, with every hidden role and
 * private channel visible. Turns a result table into something worth reading.
 */
export async function generateDebrief(args: {
  client: CompletionClient;
  model: string;
  bundle: ReplayBundle;
}): Promise<{ text: string; model: string; costUsd: number } | null> {
  const transcript = buildTranscript(args.bundle);
  const messages = [
      {
        role: 'system',
        content:
          'You are a sharp game analyst. You see the full transcript including hidden roles and private channels. ' +
          'Write a debrief in under 180 words: who lied convincingly, who was believed, the turning point, ' +
          'and one best and one worst decision. Be specific about seat names. No preamble, no headings.',
      },
    { role: 'user', content: transcript },
  ] as const;

  // Reasoning models spend the completion budget thinking before they write,
  // so a small cap yields empty content. Retry once with room to think.
  let costUsd = 0;
  for (const maxTokens of [1800, 3200]) {
    const result = await args.client.complete({
      model: args.model,
      temperature: 0.4,
      maxTokens,
      messages: [...messages],
    });
    costUsd += result.usage.costUsd;
    const text = result.text.trim();
    if (text) return { text, model: result.model, costUsd };
  }
  return null;
}

function buildTranscript(bundle: ReplayBundle): string {
  const { summary, events, godViews } = bundle;
  const names = new Map(summary.seats.map((seat) => [seat.seatId, seat.name]));
  const final = godViews.at(-1);
  const data = (final?.data ?? {}) as Record<string, unknown>;
  const god = (data.god ?? {}) as { roles?: Record<string, string> };

  const lines: string[] = [];
  lines.push(`Game: ${summary.gameName}. Result: ${summary.winnerNames.join(', ') || 'no winner'}.`);
  lines.push('Seats:');
  for (const seat of summary.seats) {
    const role = seat.role ?? god.roles?.[seat.seatId] ?? 'unknown';
    lines.push(`- ${seat.name} (${seat.modelId ?? seat.kind}): ${role}`);
  }

  const chat = final?.chat ?? [];
  if (chat.length > 0) {
    lines.push('', 'Talk:');
    for (const line of chat) {
      const who = names.get(line.seatId) ?? line.seatId;
      const channel = line.channel === 'public' ? '' : ` [${line.channel}]`;
      lines.push(`${who}${channel}: ${line.text}`);
    }
  }

  const log = Array.isArray(data.log) ? (data.log as string[]) : [];
  if (log.length > 0) {
    lines.push('', 'Events:');
    for (const entry of log.slice(-30)) lines.push(`- ${entry}`);
  }

  lines.push('', 'Actions:');
  for (const event of events.slice(-60)) {
    const who = names.get(event.seatId) ?? event.seatId;
    lines.push(`${who} — ${event.action.type}${event.action.target ? ` ${String(event.action.target)}` : ''}`);
  }
  return lines.join('\n');
}
