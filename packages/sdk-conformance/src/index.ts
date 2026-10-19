/**
 * The cross-game compatibility gate (M2c).
 *
 * Everything here is generic: it runs against any GameDef. Both shipped games
 * and every future plugin must pass it before the UI, agent layer or stats
 * pipeline is allowed to depend on the interface.
 */
import {
  IllegalAction,
  RandomBot,
  findLeaks,
  runMatch,
  type GameAction,
  type GameDef,
  type Seat,
  type SeatId,
} from '@gametable/engine';
import { auditCapabilities, runGatewayRoundTrip, runPipelineCheck } from './audits.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceOptions {
  /** Seeds used for deterministic playouts. */
  seeds?: number[];
  /** A full match is run for every seat count in minSeats..maxSeats. */
  playoutsPerSeatCount?: number;
  /** Hard bound on how many actions a healthy match may take. */
  maxActions?: number;
}

export function seatRoster(count: number, kind: Seat['kind'] = 'bot'): Seat[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`,
    name: `Seat ${i + 1}`,
    kind,
  }));
}

export async function runConformance<S>(
  def: GameDef<S>,
  options: ConformanceOptions = {},
): Promise<CheckResult[]> {
  const seeds = options.seeds ?? [1, 2, 3];
  const playouts = options.playoutsPerSeatCount ?? 3;
  const maxActions = options.maxActions ?? 5_000;
  const results: CheckResult[] = [];

  const checks: Array<{ name: string; run: () => Promise<string | void> }> = [
    {
      name: 'every seat count completes a match',
      run: async () => {
        for (let count = def.minSeats; count <= def.maxSeats; count++) {
          for (let p = 0; p < playouts; p++) {
            const seats = seatRoster(count);
            const result = await runMatch(def, seats, bots(seats, p), {
              seed: seeds[p % seeds.length] as number,
              maxActions,
              actionTimeoutMs: 1_000,
            });
            if (result.events.length === 0) throw new Error(`seat count ${count}: no actions`);
            if (result.winners.length === 0) throw new Error(`seat count ${count}: no winner`);
          }
        }
      },
    },
    {
      name: 'same seed and actions produce the same match',
      run: async () => {
        const seats = seatRoster(def.minSeats);
        const a = await runMatch(def, seats, bots(seats, 11), { seed: 99, maxActions });
        const b = await runMatch(def, seats, bots(seats, 11), { seed: 99, maxActions });
        expectEqual(stripTime(a.events), stripTime(b.events), 'event logs differ');
        expectEqual(a.scores, b.scores, 'scores differ');
        expectEqual(a.metrics, b.metrics, 'metrics differ');
      },
    },
    {
      name: 'replay reconstructs the final state',
      run: async () => {
        const seats = seatRoster(def.minSeats);
        const match = await runMatch(def, seats, bots(seats, 5), { seed: 7, maxActions });
        let state = def.setup({ seed: match.seed, seats, options: {} });
        for (const event of match.events) state = def.apply(state, event.seatId, event.action);
        expectEqual(def.scoring(state), { winners: match.winners, scores: match.scores }, 'replay diverged');
        expectEqual(def.metrics(state), match.metrics, 'replayed metrics diverged');
      },
    },
    {
      name: 'state survives a JSON round-trip',
      run: async () => {
        const seats = seatRoster(def.minSeats);
        const match = await runMatch(def, seats, bots(seats, 3), { seed: 21, maxActions });
        let state = def.setup({ seed: match.seed, seats, options: {} });
        for (const event of match.events.slice(0, Math.min(3, match.events.length))) {
          const revived = JSON.parse(JSON.stringify(state)) as S;
          for (const seat of seats) {
            expectEqual(
              JSON.parse(JSON.stringify(def.view(revived, seat.id))),
              JSON.parse(JSON.stringify(def.view(state, seat.id))),
              `view for ${seat.id} changed after round-trip`,
            );
          }
          state = def.apply(state, event.seatId, event.action);
        }
      },
    },
    {
      name: 'illegal actions are rejected',
      run: async () => {
        const seats = seatRoster(def.minSeats);
        const state = def.setup({ seed: 4, seats, options: {} });
        const actor = def.phase(state).actor;
        if (!actor) throw new Error('no actor in the opening phase');
        let threw = false;
        try {
          def.apply(state, actor, { type: 'definitely-not-a-real-action' });
        } catch (error) {
          threw = error instanceof IllegalAction;
        }
        if (!threw) throw new Error('engine accepted a bogus action');
      },
    },
    {
      name: 'the acting seat always has a legal move',
      run: async () => {
        for (let count = def.minSeats; count <= def.maxSeats; count++) {
          for (const seed of seeds) {
            const seats = seatRoster(count);
            let state = def.setup({ seed, seats, options: {} });
            let steps = 0;
            while (!def.terminal(state)) {
              const phase = def.phase(state);
              const actors = phase.kind === 'simultaneous' ? phase.actors : phase.actor ? [phase.actor] : [];
              if (actors.length === 0) throw new Error(`phase ${phase.id} has no actors`);
              for (const actorId of actors) {
                const view = def.view(state, actorId);
                if (view.legalActions.length === 0) {
                  throw new Error(`seat ${actorId} has no legal actions in ${phase.id}`);
                }
              }
              // Apply every actor in the phase: simultaneous phases only
              // advance once all of them have acted.
              for (const actorId of actors) {
                const action = def.view(state, actorId).legalActions[0] as GameAction;
                state = def.apply(state, actorId, action);
                if (def.terminal(state)) break;
              }
              if (++steps > maxActions) throw new Error('detected a possible loop');
            }
          }
        }
      },
    },
    {
      name: 'no seat sees another seat\'s secrets',
      run: async () => {
        for (let count = def.minSeats; count <= def.maxSeats; count++) {
          for (const seed of seeds) {
            const seats = seatRoster(count);
            let state = def.setup({ seed, seats, options: {} });
            const ids = seats.map((s) => s.id);
            let steps = 0;
            while (!def.terminal(state) && steps++ < maxActions) {
              const leaks = findLeaks(def, state, ids);
              if (leaks.length > 0) {
                throw new Error(
                  `seed ${seed}, step ${steps}: ` +
                    leaks.map((l) => `${l.seatId} sees ${l.leaked.join(',')}`).join('; '),
                );
              }
              const phase = def.phase(state);
              const actors = phase.kind === 'simultaneous' ? phase.actors : phase.actor ? [phase.actor] : [];
              for (const actorId of actors) {
                const action = def.view(state, actorId).legalActions[0] as GameAction;
                state = def.apply(state, actorId, action);
              }
            }
          }
        }
      },
    },
    {
      name: 'unknown seats are rejected',
      run: async () => {
        const seats = seatRoster(def.minSeats);
        const state = def.setup({ seed: 4, seats, options: {} });
        let threw = false;
        try {
          def.view(state, 'ghost-seat');
        } catch {
          threw = true;
        }
        if (!threw) throw new Error('view() returned a projection for an unknown seat');
      },
    },
    {
      name: 'capabilities satisfy the platform contract',
      run: async () => {
        const issues = auditCapabilities(def);
        if (issues.length > 0) throw new Error(issues.join('; '));
        return `${def.capabilities.uiPanels.length} panels declared`;
      },
    },
    {
      name: 'a full match is playable through the LLM gateway',
      run: async () => {
        const trip = await runGatewayRoundTrip(def);
        if (trip.result.events.length === 0) throw new Error('the match produced no actions');
        if (trip.fallbacks > 0) {
          throw new Error(`${trip.fallbacks} fallback actions: a model reply was rejected`);
        }
        return `${trip.result.events.length} actions, ${trip.calls} model calls`;
      },
    },
    {
      name: 'results survive the store and produce ratings',
      run: async () => {
        const { records, ratings } = await runPipelineCheck(def);
        if (ratings.length === 0) throw new Error('no model ratings produced');
        return `${records.length} record, ${ratings.length} rated models`;
      },
    },
  ];

  for (const check of checks) {
    try {
      const detail = await check.run();
      results.push({ name: check.name, ok: true, detail: detail ?? undefined });
    } catch (error) {
      results.push({
        name: check.name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;}

function bots(seats: Seat[], salt: number): Map<SeatId, RandomBot> {
  return new Map(seats.map((seat, i) => [seat.id, new RandomBot(salt * 1000 + i + 1)]));
}

function stripTime(events: Array<{ at?: number }>): unknown {
  return events.map(({ at: _at, ...rest }) => rest);
}

function expectEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nactual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`);
  }
}

export { mines } from './toy-mines.js';
export type { MinesState } from './toy-mines.js';
export * from './audits.js';
export * from './fake-model.js';
