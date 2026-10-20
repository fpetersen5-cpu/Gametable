import type { MatchRecord } from './record.js';

export interface ModelRating {
  modelId: string;
  /** 1500-centred, like Elo. */
  rating: number;
  matches: number;
  wins: number;
  losses: number;
  invalidActions: number;
  avgCostUsd: number;
  avgLatencyMs: number;
  /** Average game-defined metric per match (e.g. EV loss). */
  metrics: Record<string, number>;
}

export interface RatingOptions {
  iterations?: number;
  /** Weight a win/loss pair, e.g. to correct role imbalance. Default 1. */
  weight?: (record: MatchRecord, winnerSeatId: string, loserSeatId: string) => number;
}

/**
 * Bradley–Terry over pairwise wins, fitted with the standard MM algorithm.
 *
 * Every match is expanded into winner-vs-loser pairs, so multi-player games
 * and team wins fall out naturally. Ratings are rescaled to a 1500-centred
 * Elo-like number, but the underlying fit is far more stable than Elo for the
 * sparse data a new install will have.
 */
export function bradleyTerry(records: MatchRecord[], options: RatingOptions = {}): ModelRating[] {
  const iterations = options.iterations ?? 200;
  const weight = options.weight ?? (() => 1);

  const pairs = new Map<string, Map<string, number>>(); // wins[i][j]
  const games = new Map<string, Map<string, number>>(); // n[i][j] (both directions)
  const totals = new Map<
    string,
    { matches: number; wins: number; losses: number; invalidActions: number; cost: number; latency: number; metrics: Map<string, number> }
  >();

  const touch = (id: string) => {
    if (!totals.has(id)) {
      totals.set(id, { matches: 0, wins: 0, losses: 0, invalidActions: 0, cost: 0, latency: 0, metrics: new Map() });
      pairs.set(id, new Map());
      games.set(id, new Map());
    }
  };

  // Human seats are a fixed anchor: beating a person moves your rating, but the
  // person never appears on the board. This keeps 1v1 duels meaningful.
  const ANCHOR = '\u0000human';
  const strengthOf = (id: string) =>
    id === ANCHOR ? 1 : (strength.get(id) ?? 1);

  const pairRow = (map: Map<string, Map<string, number>>, id: string) => {
    let row = map.get(id);
    if (!row) {
      row = new Map();
      map.set(id, row);
    }
    return row;
  };

  const addPair = (w: string, l: string, wWeight: number): void => {
    if (w === l || wWeight <= 0) return;
    const wRow = pairRow(pairs, w);
    wRow.set(l, (wRow.get(l) ?? 0) + wWeight);
    const wGames = pairRow(games, w);
    wGames.set(l, (wGames.get(l) ?? 0) + wWeight);
    const lGames = pairRow(games, l);
    lGames.set(w, (lGames.get(w) ?? 0) + wWeight);
  };

  for (const record of records) {
    const models = record.seats.filter((s) => s.kind === 'llm' && s.modelId);
    if (models.length === 0) continue;
    for (const seat of models) touch(seat.modelId as string);

    for (const seat of models) {
      const total = totals.get(seat.modelId as string);
      if (!total) continue;
      total.matches += 1;
      if (record.winnerSeats.includes(seat.seatId)) total.wins += 1;
      else total.losses += 1;
      total.invalidActions += seat.invalidActions;
      total.cost += seat.costUsd;
      total.latency += seat.latencyMs;
    }
    // Per-seat metrics (EV loss and friends) beat game-wide aggregates.
    const hasSeatMetrics = models.some((seat) => seat.metrics);
    if (hasSeatMetrics) {
      for (const seat of models) {
        const total = totals.get(seat.modelId as string);
        if (!total) continue;
        for (const [name, value] of Object.entries(seat.metrics ?? {})) {
          total.metrics.set(name, (total.metrics.get(name) ?? 0) + value);
        }
      }
    } else {
      for (const [name, value] of Object.entries(record.metrics)) {
        for (const seat of models) {
          const total = totals.get(seat.modelId as string);
          if (!total) continue;
          total.metrics.set(name, (total.metrics.get(name) ?? 0) + value / models.length);
        }
      }
    }

    const winners = models.filter((s) => record.winnerSeats.includes(s.seatId));
    const losers = models.filter((s) => !record.winnerSeats.includes(s.seatId));

    for (const winner of winners) {
      for (const loser of losers) {
        const w = winner.modelId as string;
        const l = loser.modelId as string;
        if (w === l) continue; // same model in two seats: no information
        addPair(w, l, weight(record, winner.seatId, loser.seatId));
      }
    }

    for (const human of record.seats.filter((seat) => seat.kind === 'human')) {
      const humanWon = record.winnerSeats.includes(human.seatId);
      for (const seat of models) {
        const modelWon = record.winnerSeats.includes(seat.seatId);
        if (modelWon && !humanWon) addPair(seat.modelId as string, ANCHOR, 1);
        else if (!modelWon && humanWon) addPair(ANCHOR, seat.modelId as string, 1);
      }
    }
  }

  const ids = [...totals.keys()];
  if (ids.length === 0) return [];

  const strength = new Map<string, number>(ids.map((id) => [id, 1]));

  // A weak prior against a fixed average opponent keeps a 3–0 model from
  // shooting to a nonsense rating when the sample is tiny.
  const PRIOR_WINS = 1;
  const PRIOR_GAMES = 2;

  for (let iter = 0; iter < iterations; iter++) {
    for (const id of ids) {
      const wins = pairs.get(id) ?? new Map<string, number>();
      let winsTotal = 0;
      for (const n of wins.values()) winsTotal += n;
      winsTotal += PRIOR_WINS;

      const opponents = games.get(id) ?? new Map<string, number>();
      let denom = PRIOR_GAMES / ((strength.get(id) as number) + 1);
      for (const [opponent, n] of opponents) {
        denom += n / ((strength.get(id) as number) + strengthOf(opponent));
      }
      strength.set(id, denom > 0 ? winsTotal / denom : 1e-6);
    }
    // The fixed anchor pins the scale, so no renormalisation is needed.
  }

  return ids
    .map((id) => {
      const total = totals.get(id) as NonNullable<ReturnType<typeof totals.get>>;
      const rating = 400 * Math.log10(strength.get(id) as number) + 1500;
      return {
        modelId: id,
        rating: Math.max(800, Math.min(2400, rating)),
        matches: total.matches,
        wins: total.wins,
        losses: total.losses,
        invalidActions: total.invalidActions,
        avgCostUsd: total.matches ? total.cost / total.matches : 0,
        avgLatencyMs: total.matches ? total.latency / total.matches : 0,
        metrics: Object.fromEntries(
          [...total.metrics.entries()].map(([k, v]) => [k, total.matches ? v / total.matches : 0]),
        ),
      };
    })
    .sort((a, b) => b.rating - a.rating);
}
