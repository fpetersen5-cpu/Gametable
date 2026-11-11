import type { ChatLine, Phase, SeatInfo } from '../../shared/api';

export function mafiaPhaseIsNight(phase: Phase): boolean {
  return phase.id === 'night' || phase.id.startsWith('night-') || phase.id === 'mafia-talk';
}

/** Only use the projected phase. A waiting town seat must see the whole town asleep. */
export function mafiaSceneState(phase: Phase, seats: SeatInfo[], chat: ChatLine[] = [], previews: Record<string, string> = {}) {
  const night = mafiaPhaseIsNight(phase);
  const activeIds = phase.id === 'night' ? [] : phase.actors.filter((id) => seats.some((seat) => seat.id === id && seat.alive !== false));
  const draft = Object.entries(previews).find(([id, text]) => activeIds.includes(id) && text.trim());
  const lastLine = phase.id === 'night' ? undefined : chat.findLast((line) =>
    line.phaseId === phase.id && line.round === phase.round && (night ? line.channel === 'mafia' : line.channel === 'public'),
  );
  return {
    night,
    activeIds,
    activeSeatId: activeIds[0] ?? null,
    speakingSeatId: draft?.[0] ?? null,
    speakerId: draft?.[0] ?? lastLine?.seatId ?? activeIds[0] ?? null,
    dialogue: draft?.[1] ?? lastLine?.text,
    channel: draft ? 'Speaking' : lastLine?.channel === 'mafia' ? 'Private council' : 'Council record',
  };
}

export function mafiaNightMessage(phase: Phase): string {
  switch (phase.id) {
    case 'mafia-talk': return 'The mafia confer in private. The town sleeps.';
    case 'night-kill': return 'The mafia choose a target under cover of darkness.';
    case 'night-save': return 'Choose someone to protect before dawn.';
    case 'night-check': return 'Choose someone to investigate before dawn.';
    default: return 'The town is asleep. The night’s outcome will be revealed at dawn.';
  }
}
