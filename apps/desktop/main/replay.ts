import type { GameDef, GameView, SeatId } from '@gametable/engine';
import type { ReplayBundle } from '../shared/api.js';

/**
 * The replay cannot be rebuilt exactly. Surfaced to the user instead of
 * projecting a different match and passing it off as the record.
 */
export class ReplayIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayIncompatibleError';
  }
}

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
  let state: S;
  try {
    state = def.setup({
      seed: bundle.seed,
      seats: bundle.seats,
      // Bundles written before options were stored have no record of the
      // setup. Defaults often reproduce the match, but not always, so the
      // result is verified against the stored god view below.
      options: bundle.options ?? {},
    });
  } catch (error) {
    throw new ReplayIncompatibleError(
      `This replay cannot be set up again (${error instanceof Error ? error.message : 'unknown error'}).`,
    );
  }

  const views: GameView[] = [def.view(state, seatId)];
  for (const [index, event] of bundle.events.entries()) {
    try {
      state = def.apply(state, event.seatId, event.action);
    } catch (error) {
      throw new ReplayIncompatibleError(
        `This replay stops matching its record at action ${index + 1}. It was probably ` +
          `recorded with different setup options.`,
      );
    }
    views.push(def.view(state, seatId));
  }

  // The old build stored an omniscient view for every step. Rebuild the final
  // one and compare: if the replayed state diverges, the seat projections would
  // be fiction, so refuse them.
  const stored = bundle.godViews?.[bundle.godViews.length - 1];
  if (stored && def.godView) {
    const rebuilt = def.godView(state);
    if (JSON.stringify(rebuilt) !== JSON.stringify(stored)) {
      throw new ReplayIncompatibleError(
        'This replay was recorded with setup options it did not store, so the ' +
          'seat view cannot be rebuilt faithfully.',
      );
    }
  }

  return views;
}
