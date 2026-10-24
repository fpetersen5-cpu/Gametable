import type { GameDef, GameView, SeatId } from './types.js';

export interface LeakReport {
  seatId: SeatId;
  leaked: string[];
}

/**
 * Serialises a seat's view and looks for strings that the seat must not see.
 * Secrets shorter than `minLength` are ignored — hunting for single characters
 * produces noise, not signal.
 * This checks literal occurrences only. Synthetic labels not present in the
 * hidden values cannot detect raw-state leaks; supplement with game-specific
 * counterfactual view tests (assertViewNonInterference in sdk-conformance).
 */
export function findLeaks<S>(
  def: GameDef<S>,
  state: S,
  seatIds: SeatId[],
  minLength = 3,
): LeakReport[] {
  const reports: LeakReport[] = [];
  for (const seatId of seatIds) {
    const view = def.view(state, seatId);
    const serialised = serialise(view);
    const leaked = def
      .secrets(state, seatId)
      .filter((secret) => secret.length >= minLength)
      .filter((secret) => serialised.includes(secret));
    if (leaked.length > 0) reports.push({ seatId, leaked });
  }
  return reports;
}

export function serialise(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}

export function assertCleanView<S>(def: GameDef<S>, state: S, seatIds: SeatId[]): void {
  const leaks = findLeaks(def, state, seatIds);
  if (leaks.length > 0) {
    const detail = leaks
      .map((r) => `seat ${r.seatId} can see ${r.leaked.map((s) => JSON.stringify(s)).join(', ')}`)
      .join('; ');
    throw new Error(`information leak: ${detail}`);
  }
}

/** A view must be JSON-serialisable; save/resume depends on it. */
export function assertSerialisable(view: GameView): void {
  const roundTripped = JSON.parse(serialise(view)) as unknown;
  if (serialise(roundTripped) !== serialise(view)) {
    throw new Error('view does not survive a JSON round-trip');
  }
}
