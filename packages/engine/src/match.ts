import { ControllerTimeout } from './errors.js';
import type { MatchEvent } from './events.js';
import type {
  GameAction,
  GameDef,
  GameView,
  Seat,
  SeatId,
  SeatKind,
  Scoring,
} from './types.js';

export interface ActionRequest {
  matchId: string;
  seat: Seat;
  /** The seat's entire knowledge. Prompt building must use nothing else. */
  view: GameView;
  timeoutMs: number;
}

export interface SeatUsage {
  calls: number;
  invalidActions: number;
  fallbacks: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
}

export interface Controller {
  readonly kind: SeatKind;
  act(req: ActionRequest): Promise<GameAction>;
  /** Live counters (tokens, cost, latency) reported after the match. */
  usage?(): Partial<SeatUsage>;
}

export interface MatchSeatResult {
  seatId: SeatId;
  name: string;
  kind: SeatKind;
  modelId?: string;
  role?: string;
  metrics?: Record<string, number>;
  usage: SeatUsage;
}

export interface MatchResult {
  matchId: string;
  gameId: string;
  gameVersion: string;
  engineVersion: string;
  seed: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  seats: MatchSeatResult[];
  winners: SeatId[];
  scores: Record<SeatId, number>;
  metrics: Record<string, number>;
  events: MatchEvent[];
}

export interface RunOptions {
  matchId?: string;
  seed: number;
  actionTimeoutMs?: number;
  /** How many invalid responses a seat may give before the engine picks for it. */
  maxInvalidActions?: number;
  /** Hard guard against a game that never terminates. */
  maxActions?: number;
  options?: Record<string, unknown>;
  onEvent?: (event: MatchEvent) => void;
  now?: () => number;
}

export const ENGINE_VERSION = '0.1.0';

function emptyUsage(): SeatUsage {
  return {
    calls: 0,
    invalidActions: 0,
    fallbacks: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    latencyMs: 0,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, seatId: SeatId): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ControllerTimeout(seatId, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * A submission is legal when it carries the option's `type` and agrees with
 * every field of the option. Extra fields (a model's reasoning, a persona tag)
 * are stripped so they can never reach game state.
 */
export function matchAction(legal: GameAction[], submitted: unknown): GameAction | null {
  if (typeof submitted !== 'object' || submitted === null) return null;
  const candidate = submitted as Record<string, unknown>;
  if (typeof candidate.type !== 'string') return null;
  for (const option of legal) {
    if (option.type !== candidate.type) continue;
    const agrees = Object.entries(option).every(([key, value]) =>
      key === 'type' ? true : deepEqual(candidate[key], value),
    );
    if (agrees) return option;
  }
  return null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

async function obtainAction<S>(
  def: GameDef<S>,
  state: S,
  seat: Seat,
  controller: Controller,
  usage: SeatUsage,
  opts: Required<Pick<RunOptions, 'actionTimeoutMs' | 'maxInvalidActions'>>,
  matchId: string,
): Promise<{ action: GameAction; view: GameView }> {
  const view = def.view(state, seat.id);
  const legal = view.legalActions;
  if (legal.length === 0) {
    throw new Error(`seat ${seat.id} has no legal actions in phase ${view.phase.id}`);
  }

  for (let attempt = 0; attempt < opts.maxInvalidActions; attempt++) {
    const started = Date.now();
    usage.calls += 1;
    let submitted: unknown;
    try {
      submitted = await withTimeout(
        controller.act({ matchId, seat, view, timeoutMs: opts.actionTimeoutMs }),
        opts.actionTimeoutMs,
        seat.id,
      );
    } catch (err) {
      // Timeouts and transport failures consume an attempt; the seat may recover.
      if (attempt === opts.maxInvalidActions - 1) break;
      usage.latencyMs += Date.now() - started;
      continue;
    }
    usage.latencyMs += Date.now() - started;
    const action = matchAction(legal, submitted);
    if (action) return { action, view };
    usage.invalidActions += 1;
  }

  usage.fallbacks += 1;
  return { action: legal[0] as GameAction, view };
}

/**
 * Drives a match to completion. Sequential phases ask one seat at a time;
 * simultaneous phases fan out, then apply in the game's declared order.
 */
export async function runMatch<S>(
  def: GameDef<S>,
  seats: Seat[],
  controllers: Map<SeatId, Controller>,
  options: RunOptions,
): Promise<MatchResult> {
  const matchId = options.matchId ?? `match-${options.seed}`;
  const actionTimeoutMs = options.actionTimeoutMs ?? 45_000;
  const maxInvalidActions = options.maxInvalidActions ?? 3;
  const maxActions = options.maxActions ?? 10_000;
  const now = options.now ?? (() => Date.now());

  if (seats.length < def.minSeats || seats.length > def.maxSeats) {
    throw new Error(
      `${def.id} needs ${def.minSeats}..${def.maxSeats} seats, got ${seats.length}`,
    );
  }
  for (const seat of seats) {
    if (!controllers.has(seat.id)) throw new Error(`no controller for seat ${seat.id}`);
  }

  const startedAt = now();
  let state = def.setup({ seed: options.seed, seats, options: options.options ?? {} });
  const events: MatchEvent[] = [];
  const usage = new Map<SeatId, SeatUsage>(seats.map((s) => [s.id, emptyUsage()]));

  let guard = 0;
  while (!def.terminal(state)) {
    if (guard++ >= maxActions) {
      throw new Error(`match ${matchId} exceeded ${maxActions} actions`);
    }
    const phase = def.phase(state);
    const actors = phase.kind === 'simultaneous' ? phase.actors : phase.actor ? [phase.actor] : [];
    if (actors.length === 0) {
      throw new Error(`phase ${phase.id} of ${def.id} has no actors`);
    }

    const requests = actors.map(async (seatId) => {
      const seat = seats.find((s) => s.id === seatId);
      if (!seat) throw new Error(`phase ${phase.id} names unknown seat ${seatId}`);
      const controller = controllers.get(seatId) as Controller;
      const seatUsage = usage.get(seatId) as SeatUsage;
      const result = await obtainAction(
        def,
        state,
        seat,
        controller,
        seatUsage,
        { actionTimeoutMs, maxInvalidActions },
        matchId,
      );
      return { seatId, ...result };
    });

    const results = await Promise.all(requests);
    for (const result of results) {
      state = def.apply(state, result.seatId, result.action);
      const event: MatchEvent = {
        seq: events.length,
        phaseId: phase.id,
        round: phase.round,
        seatId: result.seatId,
        action: result.action,
        at: now(),
      };
      events.push(event);
      options.onEvent?.(event);
    }
  }

  const scoring: Scoring = def.scoring(state);
  const endedAt = now();

  return {
    matchId,
    gameId: def.id,
    gameVersion: def.version,
    engineVersion: ENGINE_VERSION,
    seed: options.seed,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    seats: seats.map((seat) => {
      const base = usage.get(seat.id) as SeatUsage;
      const reported = controllers.get(seat.id)?.usage?.() ?? {};
      return {
        seatId: seat.id,
        name: seat.name,
        kind: seat.kind,
        modelId: seat.modelId,
        role: def.roleOf?.(state, seat.id),
        metrics: def.metricsFor?.(state, seat.id),
        usage: { ...base, ...reported },
      };
    }),
    winners: scoring.winners,
    scores: scoring.scores,
    metrics: def.metrics(state),
    events,
  };
}

/** Reproduce a finished match from its seed and action log. */
export function replay<S>(
  def: GameDef<S>,
  seed: number,
  seats: Seat[],
  events: MatchEvent[],
  options: Record<string, unknown> = {},
): S {
  let state = def.setup({ seed, seats, options });
  for (const event of events) {
    state = def.apply(state, event.seatId, event.action);
  }
  return state;
}
