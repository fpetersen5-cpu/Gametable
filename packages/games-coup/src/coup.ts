/**
 * Coup — 2 to 6 seats. Hidden influence cards, public claims, challenges and
 * blocks. The last player holding at least one influence card wins.
 *
 * The engine owns the hidden hands and the deck. A seat's view contains its own
 * cards, public coin/influence counts, and the claims on the table — never
 * another seat's hand or the order of the deck.
 */
import {
  IllegalAction,
  Rng,
  matchAction,
  type ChatLine,
  type GameAction,
  type GameDef,
  type GameView,
  type Phase,
  type Scoring,
  type Seat,
  type SeatId,
  type SeatInfo,
  type SetupContext,
} from '@gametable/engine';

export type CoupRole = 'Duke' | 'Assassin' | 'Captain' | 'Ambassador' | 'Contessa';
export type CoupActionType =
  | 'income'
  | 'foreign-aid'
  | 'coup'
  | 'assassinate'
  | 'steal'
  | 'tax'
  | 'exchange';

export const COUP_ROLES: CoupRole[] = [
  'Duke',
  'Assassin',
  'Captain',
  'Ambassador',
  'Contessa',
];

const ROLE_TEXT: Record<CoupRole, string> = {
  Duke: 'Tax: take 3 coins. Also blocks Foreign Aid.',
  Assassin: 'Assassinate: pay 3 coins to make a target lose an influence.',
  Captain: 'Steal: take up to 2 coins from a target. Also blocks Steal.',
  Ambassador: 'Exchange: draw 2 cards and keep any 2. Also blocks Steal.',
  Contessa: 'Blocks Assassinate.',
};

const CLAIM_ROLE: Partial<Record<CoupActionType, CoupRole>> = {
  tax: 'Duke',
  steal: 'Captain',
  assassinate: 'Assassin',
  exchange: 'Ambassador',
};

interface SeatRecord {
  id: SeatId;
  name: string;
  kind: Seat['kind'];
  modelId?: string;
}

export interface PendingAction {
  actor: SeatId;
  type: CoupActionType;
  target?: SeatId;
  claimedRole?: CoupRole;
}

export interface BlockClaim {
  blocker: SeatId;
  role: CoupRole;
}

export type CoupStep =
  | { kind: 'action'; actor: SeatId }
  | { kind: 'challenge'; actor: SeatId; queue: SeatId[]; action: PendingAction }
  | { kind: 'block'; actor: SeatId; queue: SeatId[]; action: PendingAction }
  | {
      kind: 'challenge-block';
      actor: SeatId;
      action: PendingAction;
      block: BlockClaim;
    }
  | {
      kind: 'lose';
      actor: SeatId;
      action: PendingAction;
      next: 'end-turn' | 'proceed-block' | 'resolve-action';
    }
  | { kind: 'exchange'; actor: SeatId; action: PendingAction; cards: CoupRole[] };

export interface CoupStats {
  turns: number;
  income: number;
  foreignAid: number;
  taxes: number;
  steals: number;
  exchanges: number;
  challenges: number;
  blocks: number;
  coups: number;
  assassinations: number;
  eliminations: number;
}

export interface CoupState {
  seats: SeatRecord[];
  hands: Record<SeatId, CoupRole[]>;
  coins: Record<SeatId, number>;
  deck: CoupRole[];
  discard: CoupRole[];
  turn: SeatId;
  step: CoupStep;
  chat: ChatLine[];
  log: string[];
  rngState: number;
  stats: CoupStats;
}

function seatOf(state: CoupState, seatId: SeatId): SeatRecord {
  const seat = state.seats.find((entry) => entry.id === seatId);
  if (!seat) throw new Error(`unknown seat: ${seatId}`);
  return seat;
}

function nameOf(state: CoupState, seatId: SeatId): string {
  return seatOf(state, seatId).name;
}

function handOf(state: CoupState, seatId: SeatId): CoupRole[] {
  seatOf(state, seatId);
  const hand = state.hands[seatId];
  if (!hand) throw new Error(`no hand for seat: ${seatId}`);
  return hand;
}

function coinsOf(state: CoupState, seatId: SeatId): number {
  seatOf(state, seatId);
  return state.coins[seatId] ?? 0;
}

function pushLog(state: CoupState, text: string): void {
  state.log.push(text);
}

function aliveSeats(state: CoupState): SeatRecord[] {
  return state.seats.filter((seat) => (state.hands[seat.id]?.length ?? 0) > 0);
}

function othersAlive(state: CoupState, seatId: SeatId): SeatId[] {
  return aliveSeats(state)
    .filter((seat) => seat.id !== seatId)
    .map((seat) => seat.id);
}

function nextAlive(state: CoupState, from: SeatId): SeatId | null {
  const index = state.seats.findIndex((seat) => seat.id === from);
  const start = index >= 0 ? index : -1;
  for (let step = 1; step <= state.seats.length; step += 1) {
    const candidate = state.seats[(start + step) % state.seats.length];
    if (candidate && (state.hands[candidate.id]?.length ?? 0) > 0) return candidate.id;
  }
  return null;
}

function terminal(state: CoupState): boolean {
  return aliveSeats(state).length <= 1;
}

function scoringOf(state: CoupState): Scoring {
  const alive = aliveSeats(state);
  const winners = alive.length === 1 ? [alive[0]?.id as SeatId] : [];
  const scores = Object.fromEntries(
    state.seats.map((seat) => [seat.id, winners.includes(seat.id) ? 1 : 0]),
  );
  return { winners, scores };
}

function isChallengeable(type: CoupActionType): boolean {
  return type === 'tax' || type === 'steal' || type === 'assassinate' || type === 'exchange';
}

function isBlockable(type: CoupActionType): boolean {
  return type === 'foreign-aid' || type === 'steal' || type === 'assassinate';
}

function blockRoles(type: CoupActionType): CoupRole[] {
  if (type === 'foreign-aid') return ['Duke'];
  if (type === 'steal') return ['Captain', 'Ambassador'];
  if (type === 'assassinate') return ['Contessa'];
  return [];
}

function needsTarget(type: CoupActionType): boolean {
  return type === 'coup' || type === 'assassinate' || type === 'steal';
}

function pendingFor(
  type: CoupActionType,
  actor: SeatId,
  target: SeatId | undefined,
): PendingAction {
  const claimedRole = CLAIM_ROLE[type];
  return {
    actor,
    type,
    ...(target === undefined ? {} : { target }),
    ...(claimedRole === undefined ? {} : { claimedRole }),
  };
}

function actionSummary(state: CoupState, action: PendingAction): Record<string, unknown> {
  return {
    actor: action.actor,
    actorName: nameOf(state, action.actor),
    type: action.type,
    ...(action.target === undefined
      ? {}
      : { target: action.target, targetName: nameOf(state, action.target) }),
    ...(action.claimedRole === undefined ? {} : { claimedRole: action.claimedRole }),
  };
}

function beginChallenge(state: CoupState, action: PendingAction): void {
  const queue = othersAlive(state, action.actor);
  if (queue.length === 0) {
    resolveAction(state, action);
    return;
  }
  state.step = { kind: 'challenge', actor: queue[0] as SeatId, queue, action };
}

function blockEligible(state: CoupState, action: PendingAction): SeatId[] {
  if (action.type === 'foreign-aid') return othersAlive(state, action.actor);
  if (action.type === 'steal' || action.type === 'assassinate') {
    if (action.target && (state.hands[action.target]?.length ?? 0) > 0) return [action.target];
  }
  return [];
}

function beginBlock(state: CoupState, action: PendingAction): void {
  const queue = blockEligible(state, action);
  if (queue.length === 0) {
    resolveAction(state, action);
    return;
  }
  state.step = { kind: 'block', actor: queue[0] as SeatId, queue, action };
}

function afterChallenge(state: CoupState, action: PendingAction): void {
  if (isBlockable(action.type)) beginBlock(state, action);
  else resolveAction(state, action);
}

function drawCards(state: CoupState, count: number): CoupRole[] {
  const rng = Rng.restore(state.rngState);
  if (state.deck.length < count) {
    state.deck = rng.shuffle([...state.deck, ...state.discard]);
    state.discard = [];
  }
  const drawn = state.deck.splice(0, count);
  state.rngState = rng.snapshot();
  return drawn;
}

/**
 * A player who proves a role in a challenge returns the revealed card to the
 * Court deck, shuffles it, and draws a replacement. The replacement stays
 * hidden; only the player who drew it learns its identity.
 */
function replaceRevealedCard(state: CoupState, seatId: SeatId, role: CoupRole): void {
  const hand = handOf(state, seatId);
  const index = hand.indexOf(role);
  if (index === -1) return;
  hand.splice(index, 1);
  state.deck.push(role);
  const rng = Rng.restore(state.rngState);
  state.deck = rng.shuffle(state.deck);
  const replacement = state.deck.splice(0, 1)[0];
  if (replacement) hand.push(replacement);
  state.rngState = rng.snapshot();
}

/** Returns true when the seat has lost its last influence. */
function loseInfluence(state: CoupState, seatId: SeatId, role: CoupRole): boolean {
  const hand = handOf(state, seatId);
  const index = hand.indexOf(role);
  const removed = index === -1 ? hand.pop() : hand.splice(index, 1)[0];
  if (removed) state.discard.push(removed);
  pushLog(state, `${nameOf(state, seatId)} loses the ${removed ?? role}.`);
  if (hand.length === 0) {
    state.stats.eliminations += 1;
    pushLog(state, `${nameOf(state, seatId)} is out of influence.`);
    return true;
  }
  return false;
}

function finishIfOver(state: CoupState): boolean {
  const alive = aliveSeats(state);
  if (alive.length <= 1) {
    state.step = { kind: 'action', actor: alive[0]?.id ?? state.turn };
    return true;
  }
  return false;
}

function startTurn(state: CoupState, seatId: SeatId): void {
  state.turn = seatId;
  state.step = { kind: 'action', actor: seatId };
  state.stats.turns += 1;
  pushLog(state, `It is ${nameOf(state, seatId)}'s turn.`);
}

function advanceTurn(state: CoupState): void {
  const next = nextAlive(state, state.turn);
  if (next) startTurn(state, next);
  else state.step = { kind: 'action', actor: state.turn };
}

function resolveAction(state: CoupState, action: PendingAction): void {
  const actor = action.actor;
  switch (action.type) {
    case 'income': {
      state.coins[actor] = coinsOf(state, actor) + 1;
      state.stats.income += 1;
      pushLog(state, `${nameOf(state, actor)} takes income (+1 coin).`);
      advanceTurn(state);
      return;
    }
    case 'foreign-aid': {
      state.coins[actor] = coinsOf(state, actor) + 2;
      state.stats.foreignAid += 1;
      pushLog(state, `${nameOf(state, actor)} takes foreign aid (+2 coins).`);
      advanceTurn(state);
      return;
    }
    case 'tax': {
      state.coins[actor] = coinsOf(state, actor) + 3;
      state.stats.taxes += 1;
      pushLog(state, `${nameOf(state, actor)} collects tax (+3 coins).`);
      advanceTurn(state);
      return;
    }
    case 'steal': {
      const target = action.target as SeatId;
      const amount = Math.min(2, coinsOf(state, target));
      state.coins[target] = coinsOf(state, target) - amount;
      state.coins[actor] = coinsOf(state, actor) + amount;
      state.stats.steals += 1;
      pushLog(
        state,
        amount > 0
          ? `${nameOf(state, actor)} steals ${amount} coin${amount === 1 ? '' : 's'} from ${nameOf(state, target)}.`
          : `${nameOf(state, actor)} finds nothing to steal from ${nameOf(state, target)}.`,
      );
      advanceTurn(state);
      return;
    }
    case 'exchange': {
      const drawn = drawCards(state, 2);
      state.step = { kind: 'exchange', actor, action, cards: drawn };
      pushLog(state, `${nameOf(state, actor)} draws two cards to exchange.`);
      return;
    }
    case 'assassinate': {
      state.stats.assassinations += 1;
      const target = action.target as SeatId;
      pushLog(state, `${nameOf(state, actor)} assassinates ${nameOf(state, target)}.`);
      if ((state.hands[target]?.length ?? 0) > 0) {
        state.step = { kind: 'lose', actor: target, action, next: 'end-turn' };
      } else {
        advanceTurn(state);
      }
      return;
    }
    case 'coup': {
      state.stats.coups += 1;
      const target = action.target as SeatId;
      pushLog(state, `${nameOf(state, actor)} launches a coup against ${nameOf(state, target)}.`);
      if ((state.hands[target]?.length ?? 0) > 0) {
        state.step = { kind: 'lose', actor: target, action, next: 'end-turn' };
      } else {
        advanceTurn(state);
      }
      return;
    }
  }
}

export function legalActionsFor(state: CoupState, seatId: SeatId): GameAction[] {
  if (terminal(state)) return [];
  seatOf(state, seatId);
  const step = state.step;
  if (step.actor !== seatId) return [];

  switch (step.kind) {
    case 'action': {
      const coins = coinsOf(state, seatId);
      const targets = othersAlive(state, seatId);
      if (targets.length === 0) return [];
      // Classic Coup: with 10 or more coins you must launch a coup.
      if (coins >= 10) return targets.map((target) => ({ type: 'coup', target }));

      const actions: GameAction[] = [];
      if (coins >= 7) {
        for (const target of targets) actions.push({ type: 'coup', target });
      }
      if (coins >= 3) {
        for (const target of targets) actions.push({ type: 'assassinate', target });
      }
      actions.push({ type: 'tax' });
      for (const target of targets) {
        if (coinsOf(state, target) > 0) actions.push({ type: 'steal', target });
      }
      actions.push({ type: 'exchange' });
      actions.push({ type: 'foreign-aid' });
      actions.push({ type: 'income' });
      return actions;
    }
    case 'challenge':
    case 'challenge-block':
      return [{ type: 'challenge' }, { type: 'pass' }];
    case 'block': {
      const roles = blockRoles(step.action.type);
      return [...roles.map((role) => ({ type: 'block', role })), { type: 'pass' }];
    }
    case 'lose': {
      const seen = new Set<CoupRole>();
      const actions: GameAction[] = [];
      for (const role of handOf(state, seatId)) {
        if (seen.has(role)) continue;
        seen.add(role);
        actions.push({ type: 'lose', card: role });
      }
      return actions;
    }
    case 'exchange': {
      const hand = handOf(state, seatId);
      const combined = [...hand, ...step.cards];
      const keepCount = hand.length;
      const seen = new Set<string>();
      const actions: GameAction[] = [];
      if (keepCount === 1) {
        for (const role of combined) {
          if (seen.has(role)) continue;
          seen.add(role);
          actions.push({ type: 'keep', first: role });
        }
        return actions;
      }
      for (let first = 0; first < combined.length; first += 1) {
        for (let second = first + 1; second < combined.length; second += 1) {
          const a = combined[first];
          const b = combined[second];
          if (!a || !b) continue;
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          actions.push({ type: 'keep', first: a, second: b });
        }
      }
      return actions;
    }
  }
}

function phaseOf(state: CoupState): Phase {
  if (terminal(state)) {
    const alive = aliveSeats(state);
    return {
      id: 'game-over',
      label: 'Game over',
      kind: 'sequential',
      actor: alive[0]?.id ?? null,
      actors: alive[0] ? [alive[0].id] : [],
      round: state.stats.turns,
    };
  }
  const step = state.step;
  const label =
    step.kind === 'action'
      ? `${nameOf(state, step.actor)} to act`
      : step.kind === 'challenge'
        ? `Challenge — ${nameOf(state, step.actor)}`
        : step.kind === 'block'
          ? `Block — ${nameOf(state, step.actor)}`
          : step.kind === 'challenge-block'
            ? `Challenge the block — ${nameOf(state, step.actor)}`
            : step.kind === 'lose'
              ? `Lose an influence — ${nameOf(state, step.actor)}`
              : `Exchange cards — ${nameOf(state, step.actor)}`;
  return {
    id: step.kind,
    label,
    kind: 'sequential',
    actor: step.actor,
    actors: [step.actor],
    round: state.stats.turns,
  };
}

function briefingOf(state: CoupState, seatId: SeatId): string {
  const hand = handOf(state, seatId);
  const lines = [
    `You are ${nameOf(state, seatId)}, playing Coup with ${state.seats.length} seats.`,
    'GOAL: be the last player holding at least one influence card. You start with two hidden role cards and two coins.',
    '',
    'ACTIONS (choose one on your turn):',
    '- Income: take 1 coin. Cannot be challenged or blocked.',
    '- Foreign Aid: take 2 coins. Any other player may claim Duke to block it; you may challenge the block.',
    '- Tax: claim Duke and take 3 coins. Can be challenged.',
    '- Steal: claim Captain and take up to 2 coins from a target. Can be challenged; the target may block with Captain or Ambassador.',
    '- Assassinate: pay 3 coins, claim Assassin, and make a target lose an influence. Can be challenged; the target may block with Contessa.',
    '- Exchange: claim Ambassador, draw two cards, keep any two of your four, and return the rest to the deck. Can be challenged.',
    '- Coup: pay 7 coins and make a target lose an influence. Cannot be challenged or blocked. With 10 or more coins you must choose Coup.',
    '',
    'CHALLENGES AND BLOCKS:',
    '- You may claim a role you do not hold. A challenge reveals the truth.',
    '- If a claim is challenged and you hold the role, the challenger loses an influence; otherwise you lose an influence and the action fails.',
    '- If a block is challenged and the blocker holds the role, the challenger loses an influence and the action is blocked; otherwise the blocker loses an influence and the action proceeds.',
    '- Once a challenge or block is resolved, no further reaction is offered for that action.',
    '',
    'ROLES:',
    ...COUP_ROLES.map((role) => `- ${role}: ${ROLE_TEXT[role]}`),
    '',
    `YOUR HIDDEN CARDS: ${hand.length > 0 ? hand.join(' and ') : 'none — you are out'}.`,
    'Other players see only how many influence cards you hold, not what they are. Your hand and the deck order are private.',
  ];
  return lines.join('\n');
}

function viewOf(state: CoupState, seatId: SeatId): GameView {
  const seat = seatOf(state, seatId);
  const hand = handOf(state, seatId);
  const step = state.step;
  const pending = step.kind === 'action' ? null : actionSummary(state, step.action);
  const block = step.kind === 'challenge-block' ? { ...step.block, blockerName: nameOf(state, step.block.blocker) } : null;
  const queue = 'queue' in step ? [...step.queue] : [];
  const exchangeCards =
    step.kind === 'exchange' && step.actor === seatId ? [...hand, ...step.cards] : undefined;

  const data = {
    coins: coinsOf(state, seatId),
    hand: [...hand],
    yourRole: hand.length > 0 ? hand.join(' + ') : null,
    influence: hand.length,
    players: state.seats.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      modelId: entry.modelId,
      alive: (state.hands[entry.id]?.length ?? 0) > 0,
      coins: state.coins[entry.id] ?? 0,
      influence: state.hands[entry.id]?.length ?? 0,
    })),
    step: step.kind,
    pending,
    block,
    queue,
    log: state.log.slice(-20),
    canAct: !terminal(state) && step.actor === seatId,
    over: terminal(state),
    deckCount: state.deck.length,
    discard: [...state.discard],
    ...(exchangeCards === undefined ? {} : { exchangeCards }),
  };

  const seats: SeatInfo[] = state.seats.map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    ...(entry.modelId === undefined ? {} : { modelId: entry.modelId }),
    alive: (state.hands[entry.id]?.length ?? 0) > 0,
  }));

  const scoring = scoringOf(state);
  return {
    gameId: coup.id,
    seatId,
    phase: phaseOf(state),
    seats,
    data,
    briefing: briefingOf(state, seatId),
    chat: [] as ChatLine[],
    legalActions: !terminal(state) && step.actor === seatId ? legalActionsFor(state, seatId) : [],
    terminal: terminal(state),
    winners: scoring.winners,
  };
}

export const coup: GameDef<CoupState> = {
  id: 'coup',
  name: 'Coup',
  version: '1.0.0',
  minSeats: 2,
  maxSeats: 6,
  capabilities: {
    chat: false,
    simultaneousPhases: false,
    items: false,
    health: false,
    solver: false,
    uiPanels: ['seat-ring', 'phase-banner', 'action-panel', 'coup-panel'],
  },

  setup(ctx: SetupContext): CoupState {
    if (ctx.seats.length < 2 || ctx.seats.length > 6) {
      throw new Error('Coup needs 2 to 6 seats');
    }
    const rng = Rng.fromSeed(ctx.seed);
    const deck = rng.shuffle(
      COUP_ROLES.flatMap((role) => [role, role, role] as CoupRole[]),
    );
    const seats: SeatRecord[] = ctx.seats.map((seat) => ({
      id: seat.id,
      name: seat.name,
      kind: seat.kind,
      ...(seat.modelId === undefined ? {} : { modelId: seat.modelId }),
    }));
    const hands: Record<SeatId, CoupRole[]> = {};
    const coins: Record<SeatId, number> = {};
    for (const seat of seats) {
      hands[seat.id] = deck.splice(0, 2);
      coins[seat.id] = 2;
    }
    const first = seats[0] as SeatRecord;
    const state: CoupState = {
      seats,
      hands,
      coins,
      deck,
      discard: [],
      turn: first.id,
      step: { kind: 'action', actor: first.id },
      chat: [],
      log: [],
      rngState: rng.snapshot(),
      stats: {
        turns: 1,
        income: 0,
        foreignAid: 0,
        taxes: 0,
        steals: 0,
        exchanges: 0,
        challenges: 0,
        blocks: 0,
        coups: 0,
        assassinations: 0,
        eliminations: 0,
      },
    };
    pushLog(state, `A game of Coup begins with ${seats.length} seats.`);
    pushLog(state, `It is ${first.name}'s turn.`);
    return state;
  },

  phase(state): Phase {
    return phaseOf(state);
  },

  view(state, seatId): GameView {
    return viewOf(state, seatId);
  },

  godView(state): GameView {
    const first = state.seats[0];
    if (!first) throw new Error('Coup has no seats');
    const base = viewOf(state, first.id);
    const scoring = scoringOf(state);
    return {
      ...base,
      seatId: '__all__',
      data: {
        ...(base.data as Record<string, unknown>),
        hand: [],
        yourRole: null,
        influence: 0,
        exchangeCards: undefined,
        god: {
          hands: state.hands,
          deck: [...state.deck],
          discard: [...state.discard],
        },
      },
      briefing: '',
      chat: [],
      legalActions: [],
      terminal: terminal(state),
      winners: scoring.winners,
    };
  },

  apply(state, seatId, action): CoupState {
    if (terminal(state)) throw new IllegalAction(seatId, action, 'the match is over');
    seatOf(state, seatId);
    const step = state.step;
    if (step.actor !== seatId) throw new IllegalAction(seatId, action, 'not your turn');
    const chosen = matchAction(legalActionsFor(state, seatId), action);
    if (!chosen) throw new IllegalAction(seatId, action, 'illegal action');
    const next = structuredClone(state) as CoupState;

    switch (step.kind) {
      case 'action': {
        const type = chosen.type as CoupActionType;
        if (!COUP_ROLES.length || !['income', 'foreign-aid', 'coup', 'assassinate', 'steal', 'tax', 'exchange'].includes(type)) {
          throw new IllegalAction(seatId, action, 'unknown action type');
        }
        const target = typeof chosen.target === 'string' ? chosen.target : undefined;
        if (needsTarget(type)) {
          if (target === undefined || target === seatId) {
            throw new IllegalAction(seatId, action, 'that action needs another seat');
          }
          if ((next.hands[target]?.length ?? 0) === 0) {
            throw new IllegalAction(seatId, action, 'that seat is already out');
          }
        }
        const pending = pendingFor(type, seatId, target);
        const coins = coinsOf(next, seatId);

        if (type === 'coup') {
          if (coins < 7) throw new IllegalAction(seatId, action, 'a coup costs 7 coins');
          next.coins[seatId] = coins - 7;
          next.stats.coups += 1;
          pushLog(next, `${nameOf(next, seatId)} pays 7 coins for a coup against ${nameOf(next, target as SeatId)}.`);
          next.step = { kind: 'lose', actor: target as SeatId, action: pending, next: 'end-turn' };
          return next;
        }
        if (type === 'assassinate') {
          if (coins < 3) throw new IllegalAction(seatId, action, 'an assassination costs 3 coins');
          next.coins[seatId] = coins - 3;
          pushLog(next, `${nameOf(next, seatId)} pays 3 coins to attempt an assassination of ${nameOf(next, target as SeatId)}.`);
          beginChallenge(next, pending);
          return next;
        }
        if (type === 'foreign-aid') {
          pushLog(next, `${nameOf(next, seatId)} attempts to take foreign aid.`);
          beginBlock(next, pending);
          return next;
        }
        if (type === 'income') {
          next.coins[seatId] = coins + 1;
          next.stats.income += 1;
          pushLog(next, `${nameOf(next, seatId)} takes income (+1 coin).`);
          advanceTurn(next);
          return next;
        }

        const claimed = CLAIM_ROLE[type] as CoupRole;
        pushLog(next, `${nameOf(next, seatId)} claims ${claimed} to ${labelForAction(type)}.`);
        beginChallenge(next, pending);
        return next;
      }

      case 'challenge': {
        if (chosen.type === 'pass') {
          const queue = step.queue.slice(1);
          if (queue.length === 0) {
            afterChallenge(next, step.action);
          } else {
            next.step = { ...step, actor: queue[0] as SeatId, queue };
          }
          return next;
        }
        if (chosen.type !== 'challenge') {
          throw new IllegalAction(seatId, action, 'only challenge or pass is allowed');
        }
        next.stats.challenges += 1;
        const claimed = step.action.claimedRole as CoupRole;
        const claimant = step.action.actor;
        if (handOf(next, claimant).includes(claimed)) {
          pushLog(next, `${nameOf(next, seatId)} challenges ${nameOf(next, claimant)}'s ${claimed} claim.`);
          pushLog(next, `${nameOf(next, claimant)} reveals the ${claimed}; the challenge fails.`);
          replaceRevealedCard(next, claimant, claimed);
          const nextStep =
            isBlockable(step.action.type) ? 'proceed-block' : 'resolve-action';
          next.step = { kind: 'lose', actor: seatId, action: step.action, next: nextStep };
        } else {
          pushLog(next, `${nameOf(next, seatId)} challenges ${nameOf(next, claimant)}'s ${claimed} claim.`);
          pushLog(next, `${nameOf(next, claimant)} does not hold the ${claimed}; the action fails.`);
          if (step.action.type === 'assassinate') {
            next.coins[claimant] = coinsOf(next, claimant) + 3;
            pushLog(next, `${nameOf(next, claimant)} recovers the 3 coins paid for the assassination.`);
          }
          next.step = { kind: 'lose', actor: claimant, action: step.action, next: 'end-turn' };
        }
        return next;
      }

      case 'block': {
        if (chosen.type === 'pass') {
          const queue = step.queue.slice(1);
          if (queue.length === 0) {
            resolveAction(next, step.action);
          } else {
            next.step = { ...step, actor: queue[0] as SeatId, queue };
          }
          return next;
        }
        if (chosen.type !== 'block') {
          throw new IllegalAction(seatId, action, 'only block or pass is allowed');
        }
        const role = chosen.role as CoupRole;
        if (!blockRoles(step.action.type).includes(role)) {
          throw new IllegalAction(seatId, action, 'that role cannot block this action');
        }
        next.stats.blocks += 1;
        const block: BlockClaim = { blocker: seatId, role };
        pushLog(next, `${nameOf(next, seatId)} claims ${role} to block ${nameOf(next, step.action.actor)}.`);
        next.step = { kind: 'challenge-block', actor: step.action.actor, action: step.action, block };
        return next;
      }

      case 'challenge-block': {
        if (chosen.type === 'pass') {
          pushLog(next, `The ${step.block.role} block stands; the action is blocked.`);
          advanceTurn(next);
          return next;
        }
        if (chosen.type !== 'challenge') {
          throw new IllegalAction(seatId, action, 'only challenge or pass is allowed');
        }
        next.stats.challenges += 1;
        if (handOf(next, step.block.blocker).includes(step.block.role)) {
          pushLog(next, `${nameOf(next, seatId)} challenges the ${step.block.role} block.`);
          pushLog(next, `${nameOf(next, step.block.blocker)} reveals the ${step.block.role}; the block holds.`);
          replaceRevealedCard(next, step.block.blocker, step.block.role);
          next.step = { kind: 'lose', actor: seatId, action: step.action, next: 'end-turn' };
        } else {
          pushLog(next, `${nameOf(next, seatId)} challenges the ${step.block.role} block.`);
          pushLog(next, `${nameOf(next, step.block.blocker)} does not hold the ${step.block.role}; the block fails.`);
          next.step = { kind: 'lose', actor: step.block.blocker, action: step.action, next: 'resolve-action' };
        }
        return next;
      }

      case 'lose': {
        if (chosen.type !== 'lose') {
          throw new IllegalAction(seatId, action, 'choose an influence to lose');
        }
        const card = chosen.card as CoupRole;
        if (!handOf(next, seatId).includes(card)) {
          throw new IllegalAction(seatId, action, 'you do not hold that card');
        }
        loseInfluence(next, seatId, card);
        if (finishIfOver(next)) return next;
        if (step.next === 'end-turn') advanceTurn(next);
        else if (step.next === 'proceed-block') beginBlock(next, step.action);
        else resolveAction(next, step.action);
        return next;
      }

      case 'exchange': {
        if (chosen.type !== 'keep') {
          throw new IllegalAction(seatId, action, 'choose two cards to keep');
        }
        const first = chosen.first as CoupRole;
        const second = typeof chosen.second === 'string' ? (chosen.second as CoupRole) : undefined;
        const hand = handOf(next, seatId);
        const keepCount = hand.length;
        const combined = [...hand, ...step.cards];
        const keep: CoupRole[] = [];
        const take = (role: CoupRole) => {
          const index = combined.indexOf(role);
          if (index === -1) {
            throw new IllegalAction(seatId, action, 'those cards are not available');
          }
          keep.push(combined.splice(index, 1)[0] as CoupRole);
        };
        take(first);
        if (second !== undefined) take(second);
        if (keep.length !== keepCount) {
          throw new IllegalAction(seatId, action, 'choose the right number of cards to keep');
        }
        next.hands[seatId] = keep;
        next.deck.push(...combined);
        const rng = Rng.restore(next.rngState);
        next.deck = rng.shuffle(next.deck);
        next.rngState = rng.snapshot();
        next.stats.exchanges += 1;
        pushLog(next, `${nameOf(next, seatId)} finishes exchanging cards.`);
        advanceTurn(next);
        return next;
      }
    }
  },

  scoring(state): Scoring {
    return scoringOf(state);
  },

  terminal(state): boolean {
    return terminal(state);
  },

  metrics(state): Record<string, number> {
    return { ...state.stats, alive: aliveSeats(state).length };
  },

  metricsFor(state, seatId): Record<string, number> {
    const hand = state.hands[seatId] ?? [];
    return {
      influence: hand.length,
      coins: state.coins[seatId] ?? 0,
      survived: hand.length > 0 ? 1 : 0,
    };
  },

  briefing(state, seatId): string {
    return briefingOf(state, seatId);
  },

  secrets(state, seatId): string[] {
    const secrets: string[] = [];
    for (const seat of state.seats) {
      if (seat.id === seatId) continue;
      for (const role of state.hands[seat.id] ?? []) {
        secrets.push(`#coup-hand#${seat.id}#${role}#`);
      }
    }
    state.deck.forEach((role, index) => {
      secrets.push(`#coup-deck#${index}#${role}#`);
    });
    if (state.step.kind === 'exchange' && state.step.actor !== seatId) {
      for (const role of state.step.cards) secrets.push(`#coup-drawn#${role}#`);
    }
    return secrets;
  },

  roleOf(state, seatId) {
    const hand = state.hands[seatId];
    if (!hand) return undefined;
    return hand.length > 0 ? hand.join(' / ') : 'eliminated';
  },
};

function labelForAction(type: CoupActionType): string {
  switch (type) {
    case 'tax':
      return 'collect tax';
    case 'steal':
      return 'steal';
    case 'assassinate':
      return 'assassinate';
    case 'exchange':
      return 'exchange cards';
    case 'foreign-aid':
      return 'take foreign aid';
    case 'income':
      return 'take income';
    case 'coup':
      return 'launch a coup';
  }
}
