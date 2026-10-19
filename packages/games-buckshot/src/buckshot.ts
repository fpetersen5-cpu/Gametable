/**
 * Buckshot Roulette — authentic duel rules.
 *
 * A chamber of live and blank shells. On your turn you may use any number of
 * items, then you must shoot: at yourself or at your opponent. Shooting
 * yourself with a blank keeps your turn; everything else passes it. Three
 * rounds with rising health; first to two rounds wins.
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
import { evaluate } from './oracle.js';
import { ITEMS, ITEM_ORDER, type ItemType, type Player, type ShellType } from './items.js';

export * from './items.js';

const HP_BY_ROUND = [2, 4, 6];
const ITEMS_BY_ROUND = [0, 2, 4];

export interface SeatKnowledge {
  top: ShellType | null;
  future: Array<{ offset: number; shell: ShellType }>;
}

export interface LogEntry {
  round: number;
  text: string;
  /** Private to one seat; omitted from every other seat's view. */
  privateTo?: Player;
}

export interface BuckshotState {
  seats: Seat[];
  round: number;
  maxHp: number;
  hp: [number, number];
  roundWins: [number, number];
  chamber: ShellType[];
  turn: Player;
  items: [ItemType[], ItemType[]];
  sawed: boolean;
  skip: [boolean, boolean];
  knowledge: [SeatKnowledge, SeatKnowledge];
  phase: 'turn' | 'adrenaline';
  adrenaline: { seat: Player } | null;
  over: boolean;
  rngState: number;
  log: LogEntry[];
  stats: { shots: number; itemsUsed: number };
  evLoss: [number, number];
  decisions: [number, number];
  trackOptimality: boolean;
}

function other(p: Player): Player {
  return p === 0 ? 1 : 0;
}

function emptyKnowledge(): SeatKnowledge {
  return { top: null, future: [] };
}

function countShells(chamber: ShellType[], type: ShellType): number {
  return chamber.reduce((n, shell) => (shell === type ? n + 1 : n), 0);
}

function aggregate(belt: ItemType[]): Record<ItemType, number> {
  const out = Object.fromEntries(ITEM_ORDER.map((item) => [item, 0])) as Record<ItemType, number>;
  for (const item of belt) out[item] += 1;
  return out;
}

function removeItem(belt: ItemType[], item: ItemType): ItemType[] {
  const index = belt.indexOf(item);
  if (index === -1) return belt;
  return [...belt.slice(0, index), ...belt.slice(index + 1)];
}

function freshChamber(rng: Rng): ShellType[] {
  const total = rng.range(4, 8);
  const live = rng.range(1, total - 1);
  const shells: ShellType[] = [
    ...Array.from({ length: live }, () => 'live' as const),
    ...Array.from({ length: total - live }, () => 'blank' as const),
  ];
  return rng.shuffle(shells);
}

function dealItems(rng: Rng, count: number, allowAdrenaline: boolean): ItemType[] {
  const pool = ITEM_ORDER.filter((item) => item !== 'adrenaline' || allowAdrenaline);
  return Array.from({ length: count }, () => rng.pick(pool));
}

function seatName(state: BuckshotState, p: Player): string {
  return state.seats[p]?.name ?? `Player ${p + 1}`;
}

function pushLog(state: BuckshotState, text: string, privateTo?: Player): void {
  state.log.push({ round: state.round, text, ...(privateTo === undefined ? {} : { privateTo }) });
}

function startRound(state: BuckshotState, rng: Rng, round: number, starter: Player): void {
  state.round = round;
  state.maxHp = HP_BY_ROUND[round - 1] ?? 2;
  state.hp = [state.maxHp, state.maxHp];
  state.chamber = freshChamber(rng);
  const itemCount = ITEMS_BY_ROUND[round - 1] ?? 0;
  state.items = [
    dealItems(rng, itemCount, round >= 3),
    dealItems(rng, itemCount, round >= 3),
  ];
  state.sawed = false;
  state.skip = [false, false];
  state.knowledge = [emptyKnowledge(), emptyKnowledge()];
  state.turn = starter;
  state.phase = 'turn';
  state.adrenaline = null;
  pushLog(
    state,
    `Round ${round}: ${countShells(state.chamber, 'live')} live, ` +
      `${countShells(state.chamber, 'blank')} blank. ${seatName(state, starter)} starts.`,
  );
}

function reload(state: BuckshotState, rng: Rng): void {
  state.chamber = freshChamber(rng);
  state.knowledge = [emptyKnowledge(), emptyKnowledge()];
  state.sawed = false;
  pushLog(
    state,
    `New chamber: ${countShells(state.chamber, 'live')} live, ${countShells(state.chamber, 'blank')} blank.`,
  );
}

/** A shell left the top of the chamber: everyone's offset knowledge shifts. */
function consumeKnowledge(state: BuckshotState): void {
  for (const seat of state.knowledge) {
    seat.top = null;
    seat.future = seat.future
      .map((entry) => ({ ...entry, offset: entry.offset - 1 }))
      .filter((entry) => entry.offset > 0);
  }
}

/** Pass the turn, honouring handcuffs. Returns true when the turn changed. */
function passTurn(state: BuckshotState): boolean {
  const next = other(state.turn);
  state.knowledge[state.turn].top = null;
  if (state.skip[next]) {
    state.skip[next] = false;
    pushLog(state, `${seatName(state, next)} is handcuffed — ${seatName(state, state.turn)} goes again.`);
    return false;
  }
  state.turn = next;
  return true;
}

function finishRound(state: BuckshotState, rng: Rng, winner: Player): void {
  const loser = other(winner);
  state.hp[loser] = 0;
  state.roundWins[winner] += 1;
  pushLog(
    state,
    `${seatName(state, winner)} wins round ${state.round} ` +
      `(${state.roundWins[0]}–${state.roundWins[1]}).`,
  );
  if (state.roundWins[winner] >= 2 || state.round >= 3) {
    state.over = true;
    state.phase = 'turn';
    state.adrenaline = null;
    state.turn = winner;
    return;
  }
  startRound(state, rng, state.round + 1, loser);
}

function canUse(state: BuckshotState, p: Player, item: ItemType): boolean {
  const opp = other(p);
  switch (item) {
    case 'cigarette':
      return state.hp[p] < state.maxHp;
    case 'beer':
    case 'magnifier':
    case 'inverter':
      return state.chamber.length > 0;
    case 'handsaw':
      return !state.sawed;
    case 'handcuffs':
      return !state.skip[opp];
    case 'pills':
      return state.hp[p] > 0;
    case 'burner':
      return state.chamber.length >= 2;
    case 'adrenaline':
      return state.items[opp].length > 0;
    default:
      return false;
  }
}

export function legalActionsFor(state: BuckshotState, p: Player): GameAction[] {
  if (state.over) return [];
  if (state.phase === 'adrenaline') {
    const victim = other(p);
    const seen = [...new Set(state.items[victim])];
    return seen.map((item) => ({ type: 'steal', item }));
  }
  const actions: GameAction[] = [];
  for (const item of new Set(state.items[p])) {
    if (canUse(state, p, item)) actions.push({ type: 'use', item });
  }
  actions.push({ type: 'shoot', target: 'self' });
  actions.push({ type: 'shoot', target: 'opponent' });
  return actions;
}

function useItemEffect(
  state: BuckshotState,
  rng: Rng,
  p: Player,
  item: ItemType,
): void {
  switch (item) {
    case 'cigarette':
      state.hp[p] = Math.min(state.maxHp, state.hp[p] + 1);
      pushLog(state, `${seatName(state, p)} smokes a cigarette (+1 health).`);
      break;
    case 'beer': {
      const shell = state.chamber.shift();
      if (!shell) break;
      consumeKnowledge(state);
      pushLog(state, `${seatName(state, p)} racks the shotgun: the shell was ${shell.toUpperCase()}.`);
      if (state.chamber.length === 0) reload(state, rng);
      break;
    }
    case 'magnifier': {
      const shell = state.chamber[0] ?? null;
      state.knowledge[p].top = shell;
      pushLog(
        state,
        `${seatName(state, p)} peers into the chamber: ${shell?.toUpperCase() ?? 'empty'}.`,
        p,
      );
      pushLog(state, `${seatName(state, p)} uses a magnifying glass.`);
      break;
    }
    case 'handsaw':
      state.sawed = true;
      pushLog(state, `${seatName(state, p)} saws the barrel short: the next shot deals 2.`);
      break;
    case 'handcuffs':
      state.skip[other(p)] = true;
      pushLog(state, `${seatName(state, p)} handcuffs ${seatName(state, other(p))}.`);
      break;
    case 'pills': {
      if (rng.chance(0.5)) {
        state.hp[p] = Math.min(state.maxHp, state.hp[p] + 2);
        pushLog(state, `${seatName(state, p)} takes pills and recovers 2 health.`);
      } else {
        state.hp[p] -= 1;
        pushLog(state, `${seatName(state, p)} takes pills and loses 1 health.`);
        if (state.hp[p] <= 0) finishRound(state, rng, other(p));
      }
      break;
    }
    case 'burner': {
      const maxOffset = Math.min(4, state.chamber.length - 1);
      const offset = rng.range(1, maxOffset);
      const shell = state.chamber[offset];
      if (shell) state.knowledge[p].future.push({ offset, shell });
      pushLog(
        state,
        `${seatName(state, p)} listens to a burner phone: shell #${offset + 1} is ` +
          `${shell?.toUpperCase() ?? 'unknown'}.`,
        p,
      );
      pushLog(state, `${seatName(state, p)} uses a burner phone.`);
      break;
    }
    case 'inverter': {
      const top = state.chamber[0];
      if (top) {
        state.chamber[0] = top === 'live' ? 'blank' : 'live';
        if (state.knowledge[p].top) state.knowledge[p].top = state.chamber[0] ?? null;
      }
      pushLog(state, `${seatName(state, p)} inverts the current shell.`);
      break;
    }
    case 'adrenaline':
      break; // handled by the caller, which needs the steal phase
  }
}

function shoot(
  state: BuckshotState,
  rng: Rng,
  p: Player,
  target: 'self' | 'opponent',
): void {
  if (state.chamber.length === 0) reload(state, rng);
  const shell = state.chamber.shift();
  if (!shell) return;
  state.stats.shots += 1;
  const victim = target === 'self' ? p : other(p);
  const sawed = state.sawed;
  state.sawed = false;
  consumeKnowledge(state);

  const who = target === 'self' ? 'themselves' : seatName(state, victim);
  if (shell === 'live') {
    const damage = sawed ? 2 : 1;
    state.hp[victim] -= damage;
    pushLog(
      state,
      `${seatName(state, p)} shoots ${who}: LIVE — ${damage} damage.`,
    );
    if (state.hp[victim] <= 0) {
      finishRound(state, rng, other(victim));
      return;
    }
  } else {
    pushLog(state, `${seatName(state, p)} shoots ${who}: blank.`);
  }

  const keepTurn = shell === 'blank' && target === 'self';
  if (!keepTurn) passTurn(state);
  if (state.chamber.length === 0 && !state.over) reload(state, rng);
}

function playerOf(state: BuckshotState, seatId: SeatId): Player {
  const index = state.seats.findIndex((seat) => seat.id === seatId);
  if (index !== 0 && index !== 1) throw new Error(`unknown seat: ${seatId}`);
  return index;
}

function actorOf(state: BuckshotState): Player {
  return state.phase === 'adrenaline' ? state.adrenaline?.seat ?? state.turn : state.turn;
}

function toOracleInput(state: BuckshotState) {
  return {
    hp: [...state.hp] as [number, number],
    maxHp: state.maxHp,
    live: countShells(state.chamber, 'live'),
    blank: countShells(state.chamber, 'blank'),
    turn: state.turn,
    items: [aggregate(state.items[0]), aggregate(state.items[1])] as [
      Record<ItemType, number>,
      Record<ItemType, number>,
    ],
    sawed: state.sawed,
    skip: [...state.skip] as [boolean, boolean],
  };
}

function recordOptimality(state: BuckshotState, action: GameAction): void {
  if (!state.trackOptimality || state.phase !== 'turn' || state.over) return;
  try {
    const result = evaluate(toOracleInput(state));
    const key =
      action.type === 'shoot' ? `shoot:${String(action.target)}` : `use:${String(action.item)}`;
    const q = result.byAction.get(key);
    if (q === undefined) return;
    state.evLoss[state.turn] += Math.max(0, result.best - q);
    state.decisions[state.turn] += 1;
  } catch {
    // Optimality is a benchmark add-on; never let it break a match.
  }
}

export const buckshot: GameDef<BuckshotState> = {
  id: 'buckshot',
  name: 'Buckshot Roulette',
  version: '1.0.0',
  minSeats: 2,
  maxSeats: 2,
  capabilities: {
    chat: false,
    simultaneousPhases: false,
    items: true,
    health: true,
    solver: true,
    uiPanels: ['health-bar', 'item-belt', 'chamber', 'round-tracker'],
  },

  setup(ctx: SetupContext): BuckshotState {
    if (ctx.seats.length !== 2) throw new Error('Buckshot Roulette is a duel: exactly 2 seats');
    const rng = Rng.fromSeed(ctx.seed);
    const state: BuckshotState = {
      seats: ctx.seats,
      round: 1,
      maxHp: HP_BY_ROUND[0] as number,
      hp: [0, 0],
      roundWins: [0, 0],
      chamber: [],
      turn: 0,
      items: [[], []],
      sawed: false,
      skip: [false, false],
      knowledge: [emptyKnowledge(), emptyKnowledge()],
      phase: 'turn',
      adrenaline: null,
      over: false,
      rngState: 0,
      log: [],
      stats: { shots: 0, itemsUsed: 0 },
      evLoss: [0, 0],
      decisions: [0, 0],
      trackOptimality: ctx.options.trackOptimality === true,
    };
    startRound(state, rng, 1, 0);
    const carry = ctx.options.carryItems;
    if (Array.isArray(carry) && carry.length === 2) {
      const pick = (belt: unknown): ItemType[] =>
        Array.isArray(belt)
          ? belt.filter((item): item is ItemType => ITEM_ORDER.includes(item as ItemType)).slice(0, 2)
          : [];
      state.items = [pick(carry[0]), pick(carry[1])];
      if (state.items[0].length + state.items[1].length > 0) {
        pushLog(
          state,
          `Carried items: ${state.items[0].length} for ${seatName(state, 0)}, ` +
            `${state.items[1].length} for ${seatName(state, 1)}.`,
        );
      }
    }
    state.rngState = rng.snapshot();
    return state;
  },

  phase(state): Phase {
    const actor = actorOf(state);
    const actorSeatId = state.seats[actor]?.id ?? null;
    return {
      id: state.phase === 'adrenaline' ? 'adrenaline' : 'turn',
      label:
        state.phase === 'adrenaline'
          ? 'Choose an item to steal'
          : `${seatName(state, actor)} to act`,
      kind: 'sequential',
      actor: actorSeatId,
      actors: actorSeatId ? [actorSeatId] : [],
      round: state.round,
    };
  },

  view(state, seatId): GameView {
    const p = playerOf(state, seatId);
    const opp = other(p);
    const actor = actorOf(state);
    const seats: SeatInfo[] = state.seats.map((seat, i) => ({
      id: seat.id,
      name: seat.name,
      kind: seat.kind,
      modelId: seat.modelId,
      alive: (state.hp[i] ?? 0) > 0,
    }));
    const visibleLog = state.log
      .filter((entry) => entry.privateTo === undefined || entry.privateTo === p)
      .slice(-10)
      .map((entry) => `[round ${entry.round}] ${entry.text}`);

    return {
      gameId: buckshot.id,
      seatId,
      phase: buckshot.phase(state),
      seats,
      data: {
        round: state.round,
        maxHp: state.maxHp,
        yourHp: state.hp[p],
        theirHp: state.hp[opp],
        yourItems: [...state.items[p]],
        theirItemCount: state.items[opp].length,
        shells: state.chamber.length,
        live: countShells(state.chamber, 'live'),
        blank: countShells(state.chamber, 'blank'),
        youPeeked: state.knowledge[p],
        sawed: state.sawed,
        youAreHandcuffed: state.skip[p],
        roundWins: [state.roundWins[0], state.roundWins[1]],
        yourTurn: !state.over && actor === p,
        phase: state.phase,
        recent: visibleLog,
        over: state.over,
      },
      briefing: buckshot.briefing(state, seatId),
      chat: [] as ChatLine[],
      legalActions: !state.over && actor === p ? legalActionsFor(state, p) : [],
      terminal: state.over,
      winners: buckshot.scoring(state).winners,
    };
  },

  apply(state, seatId, action): BuckshotState {
    if (state.over) throw new IllegalAction(seatId, action, 'the match is over');
    const p = playerOf(state, seatId);
    if (p !== actorOf(state)) throw new IllegalAction(seatId, action, 'not your turn');
    const legal = legalActionsFor(state, p);
    const chosen = legal.find(
      (option) =>
        option.type === action.type &&
        option.item === action.item &&
        option.target === action.target,
    );
    if (!chosen) throw new IllegalAction(seatId, action, 'illegal action');

    const next = structuredClone(state) as BuckshotState;
    const rng = Rng.restore(next.rngState);
    recordOptimality(next, chosen);

    if (chosen.type === 'steal') {
      const item = chosen.item as ItemType;
      next.items[other(p)] = removeItem(next.items[other(p)], item);
      next.stats.itemsUsed += 1;
      next.phase = 'turn';
      next.adrenaline = null;
      next.log.push({
        round: next.round,
        text: `${seatName(next, p)} steals ${seatName(next, other(p))}'s ${ITEMS[item].name} and uses it.`,
      });
      useItemEffect(next, rng, p, item);
    } else if (chosen.type === 'use') {
      const item = chosen.item as ItemType;
      if (item === 'adrenaline') {
        next.items[p] = removeItem(next.items[p], item);
        next.phase = 'adrenaline';
        next.adrenaline = { seat: p };
        pushLog(next, `${seatName(next, p)} uses adrenaline.`);
      } else {
        next.items[p] = removeItem(next.items[p], item);
        next.stats.itemsUsed += 1;
        useItemEffect(next, rng, p, item);
      }
    } else {
      shoot(next, rng, p, chosen.target as 'self' | 'opponent');
    }

    next.rngState = rng.snapshot();
    return next;
  },

  terminal(state): boolean {
    return state.over;
  },

  scoring(state) {
    const scores: Record<SeatId, number> = {};
    state.seats.forEach((seat, i) => {
      scores[seat.id] = state.roundWins[i] ?? 0;
    });
    const winners =
      state.roundWins[0] === state.roundWins[1]
        ? []
        : [state.roundWins[0] > state.roundWins[1] ? state.seats[0]?.id : state.seats[1]?.id].filter(
            (id): id is SeatId => typeof id === 'string',
          );
    return { winners, scores };
  },

  metrics(state) {
    return {
      rounds: state.round,
      shots: state.stats.shots,
      itemsUsed: state.stats.itemsUsed,
    };
  },

  metricsFor(state, seatId): Record<string, number> {
    if (!state.trackOptimality) return {};
    const p = playerOf(state, seatId);
    const decisions = state.decisions[p] ?? 0;
    return {
      evLoss: Number((state.evLoss[p] ?? 0).toFixed(3)),
      decisions,
      evLossPerDecision: decisions ? Number(((state.evLoss[p] ?? 0) / decisions).toFixed(4)) : 0,
    };
  },

  briefing(state, seatId) {
    const p = playerOf(state, seatId);
    const itemLines = ITEM_ORDER.map(
      (item) => `- ${ITEMS[item].name}: ${ITEMS[item].description}`,
    ).join('\n');
    return [
      'Buckshot Roulette is a duel with a shotgun that holds live and blank shells.',
      'The remaining live and blank counts are public; the order is not.',
      'On your turn you may use any number of items, then you must shoot once.',
      'Shooting yourself with a blank KEEPS your turn. Every other shot passes it.',
      'A live shell deals 1 damage (2 if the barrel was sawed). At 0 health the round is lost.',
      'Three rounds, health resets each round: 2, then 4, then 6. First to two rounds wins.',
      '',
      'ITEMS',
      itemLines,
      '',
      `You are ${seatName(state, p)}, the ${p === 0 ? 'player' : 'dealer'}.`,
    ].join('\n');
  },

  secrets(state, seatId) {
    const p = playerOf(state, seatId);
    const opp = other(p);
    const secrets: string[] = [];
    state.chamber.forEach((shell, index) => {
      secrets.push(`#hidden-chamber-${index}-${shell}#`);
    });
    state.items[opp].forEach((item, index) => {
      secrets.push(`#hidden-opp-item-${index}-${item}#`);
    });
    if (state.knowledge[opp].top) {
      secrets.push(`#hidden-opp-peek-${state.knowledge[opp].top}#`);
    }
    for (const entry of state.knowledge[opp].future) {
      secrets.push(`#hidden-opp-future-${entry.offset}-${entry.shell}#`);
    }
    return secrets;
  },

  roleOf(state, seatId) {
    return playerOf(state, seatId) === 0 ? 'player' : 'dealer';
  },
};
