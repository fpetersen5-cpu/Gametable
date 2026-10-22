import type { GameDef, GameView, SeatId } from '@gametable/engine';
import type { ReplayBundle } from '../shared/api.js';

/**
 * Rebuild a finished match from its seed and action log, then project every
 * step through one seat's eyes. This is how the replay can show "what did seat
 * 4 actually know?" without storing ten extra copies of every view.
 */
export function projectSeatViews<S>(
  def: GameDef<S>,
  bundle: ReplayBundle,
  seatId: SeatId,
): GameView[] {
  let state = def.setup({
    seed: bundle.seed,
    seats: bundle.seats,
    options: bundle.options ?? {},
  });
  const views: GameView[] = [def.view(state, seatId)];
  for (const event of bundle.events) {
    state = def.apply(state, event.seatId, event.action);
    views.push(def.view(state, seatId));
  }
  return views;
}
