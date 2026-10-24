import type { GameAction, GameDef, GameView, MatchEvent, Seat } from '@gametable/engine';
import type { ReplayBundle } from '../../shared/api.js';

/** Build real replay records by applying referee actions, not canned views. */
export function replayFixture<S>(def: GameDef<S>, count: number, options: Record<string, unknown> = {}) {
  const seed = 3;
  const seats: Seat[] = Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`, name: `Seat ${i + 1}`, kind: 'bot',
  }));
  let state = def.setup({ seed, seats, options });
  const events: MatchEvent[] = [];
  const god = (): GameView => structuredClone(def.godView?.(state) ?? def.view(state, 's1'));
  const godViews = [god()];
  const views = [structuredClone(def.view(state, 's1'))];
  return {
    get state() { return state; },
    seats,
    apply(seatId: string, action: GameAction) {
      const phase = def.phase(state);
      state = def.apply(state, seatId, action);
      events.push({ seq: events.length, seatId, action, phaseId: phase.id, round: phase.round });
      views.push(structuredClone(def.view(state, 's1')));
      godViews.push(god());
    },
    bundle(): ReplayBundle {
      const scoring = def.scoring(state);
      return structuredClone({
        formatVersion: 2, seed, seats, options, events, views, godViews,
        summary: {
          matchId: 'm-privacy-123', gameId: def.id, gameName: def.name,
          startedAt: 1_700_000_000_000, durationMs: 12_300,
          winners: scoring.winners,
          winnerNames: scoring.winners.map((id) => seats.find((seat) => seat.id === id)!.name),
          seats: seats.map((seat) => ({
            seatId: seat.id, name: seat.name, kind: seat.kind, role: def.roleOf?.(state, seat.id),
            costUsd: 0, tokensIn: 0, tokensOut: 0, invalidActions: 0,
          })),
          totalCostUsd: 0.0042, eventCount: events.length, metrics: def.metrics(state),
        },
      });
    },
  };
}
