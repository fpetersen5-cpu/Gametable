/**
 * A deliberately tiny game used as an SDK fixture. If the engine can host
 * something neither Mafia nor Buckshot shaped, the abstraction has a chance.
 *
 * Rules: every seat secretly holds a bomb or a safe card. On your turn you
 * probe one other living seat. A bomb eliminates that seat and scores you a
 * point; a safe card eliminates you. Last seat standing wins.
 */
import {
  IllegalAction,
  Rng,
  type ChatLine,
  type GameAction,
  type GameDef,
  type GameView,
  type Phase,
  type Seat,
  type SeatId,
  type SeatInfo,
  type SetupContext,
} from '@gametable/engine';

export interface MinesState {
  seats: Seat[];
  flags: Record<SeatId, boolean>;
  alive: SeatId[];
  scores: Record<SeatId, number>;
  turn: number;
  rngState: number;
  log: string[];
}

export const mines: GameDef<MinesState> = {
  id: 'toy.mines',
  name: 'Mines (SDK fixture)',
  version: '1.0.0',
  minSeats: 2,
  maxSeats: 6,
  capabilities: {
    chat: false,
    simultaneousPhases: false,
    items: false,
    health: false,
    solver: false,
    uiPanels: [],
  },

  setup(ctx: SetupContext): MinesState {
    const rng = Rng.fromSeed(ctx.seed);
    const flags: Record<SeatId, boolean> = {};
    for (const seat of ctx.seats) flags[seat.id] = rng.chance(0.45);
    return {
      seats: ctx.seats,
      flags,
      alive: ctx.seats.map((s) => s.id),
      scores: Object.fromEntries(ctx.seats.map((s) => [s.id, 0])),
      turn: 0,
      rngState: rng.snapshot(),
      log: [],
    };
  },

  phase(state): Phase {
    const actor = state.alive[state.turn % Math.max(state.alive.length, 1)] ?? null;
    return {
      id: 'probe',
      label: 'Probe a seat',
      kind: 'sequential',
      actor,
      actors: actor ? [actor] : [],
      round: state.turn,
    };
  },

  view(state, seatId): GameView {
    if (!(seatId in state.flags)) throw new Error(`unknown seat: ${seatId}`);
    const seats: SeatInfo[] = state.seats.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      modelId: s.modelId,
      alive: state.alive.includes(s.id),
    }));
    const alive = state.alive.includes(seatId);
    const targets = state.alive.filter((id) => id !== seatId);
    return {
      gameId: mines.id,
      seatId,
      phase: this.phase(state),
      seats,
      data: {
        alive,
        yourScore: state.scores[seatId] ?? 0,
        scores: state.alive.map((id) => ({ seatId: id, score: state.scores[id] ?? 0 })),
      },
      briefing: this.briefing(state, seatId),
      chat: [] as ChatLine[],
      legalActions: alive ? targets.map((t) => ({ type: 'probe', target: t })) : [],      terminal: this.terminal(state),
      winners: this.terminal(state) ? this.scoring(state).winners : [],
    };
  },

  apply(state, seatId, action: GameAction): MinesState {
    const view = mines.view(state, seatId);
    const legal = view.legalActions.some(
      (a) => a.type === action.type && a.target === action.target,
    );
    if (!legal) throw new IllegalAction(seatId, action, 'illegal probe');
    const target = String(action.target);
    const hit = state.flags[target] === true;
    const next: MinesState = {
      ...state,
      alive: [...state.alive],
      scores: { ...state.scores },
      log: [...state.log],
      turn: state.turn + 1,
    };
    if (hit) {
      next.alive = next.alive.filter((id) => id !== target);
      next.scores[seatId] = (next.scores[seatId] ?? 0) + 1;
      next.log.push(`${seatId} bombed ${target}`);
    } else {
      next.alive = next.alive.filter((id) => id !== seatId);
      next.log.push(`${seatId} probed safely and lost`);
    }
    return next;
  },

  terminal(state): boolean {
    return state.alive.length <= 1 || state.turn > 200;
  },

  scoring(state) {
    const winners =
      state.alive.length === 1
        ? state.alive
        : Object.entries(state.scores)
            .filter(([, score]) => score === Math.max(...Object.values(state.scores), 0))
            .map(([id]) => id);
    return { winners, scores: state.scores };
  },

  metrics(state) {
    return { probes: state.log.length };
  },

  briefing(state, seatId) {
    return [
      'Mines: probe another seat. A bomb removes them and scores you a point;',
      'a safe card removes you. Last seat standing wins.',
      `You are seat ${seatId}.`,
    ].join('\n');
  },

  secrets(state, seatId) {
    return Object.entries(state.flags)
      .filter(([id]) => id !== seatId)
      .map(([id, bomb]) => `toy-hidden:${id}:${bomb ? 'bomb' : 'safe'}`);
  },

  roleOf(state, seatId) {
    return state.flags[seatId] ? 'bomb' : 'safe';
  },
};
