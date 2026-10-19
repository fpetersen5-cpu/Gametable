/**
 * Gauntlet: a ladder of duels against different models.
 *
 * The hero seat stays the same; the opponent changes each duel. Up to two
 * items survive a win or a loss and carry into the next duel's opening, so the
 * later duels are about resource management, not just probability.
 */
import {
  replay,
  runMatch,
  type Controller,
  type MatchResult,
  type Seat,
  type SeatId,
} from '@gametable/engine';
import { buckshot, type BuckshotState, type ItemType } from './buckshot.js';

export interface GauntletOpponent {
  seat: Seat;
  controller: Controller;
}

export interface GauntletOptions {
  hero: Seat;
  heroController: Controller;
  opponents: GauntletOpponent[];
  seed: number;
  trackOptimality?: boolean;
  onDuel?: (duel: GauntletDuel, index: number) => void;
}

export interface GauntletDuel {
  opponent: Seat;
  result: MatchResult;
  /** Items the hero keeps for the next duel. */
  carried: ItemType[];
}

export interface GauntletResult {
  heroSeatId: SeatId;
  duels: GauntletDuel[];
  duelsWon: number;
  roundWins: number;
  totalCostUsd: number;
}

export async function runGauntlet(options: GauntletOptions): Promise<GauntletResult> {
  const duels: GauntletDuel[] = [];
  let carry: ItemType[] = [];

  for (const [index, opponent] of options.opponents.entries()) {
    const seats: Seat[] = [options.hero, opponent.seat];
    const controllers = new Map<SeatId, Controller>([
      [options.hero.id, options.heroController],
      [opponent.seat.id, opponent.controller],
    ]);
    const matchOptions = {
      trackOptimality: options.trackOptimality === true,
      carryItems: [carry, []],
    };
    const seed = options.seed + index;
    const result = await runMatch(buckshot, seats, controllers, {
      seed,
      options: matchOptions,
      maxActions: 400,
    });
    const final = replay(buckshot, seed, seats, result.events, matchOptions) as BuckshotState;
    carry = final.items[0].slice(0, 2);

    const duel: GauntletDuel = { opponent: opponent.seat, result, carried: carry };
    duels.push(duel);
    options.onDuel?.(duel, index);
  }

  return {
    heroSeatId: options.hero.id,
    duels,
    duelsWon: duels.filter((duel) => duel.result.winners.includes(options.hero.id)).length,
    roundWins: duels.reduce((sum, duel) => sum + (duel.result.scores[options.hero.id] ?? 0), 0),
    totalCostUsd: duels.reduce(
      (sum, duel) => sum + duel.result.seats.reduce((s, seat) => s + seat.usage.costUsd, 0),
      0,
    ),
  };
}
