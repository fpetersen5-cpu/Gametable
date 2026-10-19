/**
 * Exact-looking solver for Buckshot Roulette decisions.
 *
 * It evaluates the game the way a perfect player would, given:
 *   - both players' items (the oracle is allowed to see them),
 *   - the public live/blank counts,
 *   - the mover's knowledge of the next shell (from magnifier / burner).
 *
 * The shell ORDER is unknown, which is the real uncertainty in the game. Two
 * documented approximations: a refilled chamber is assumed to be 2 live / 2
 * blank, and the burner phone is modelled as a peek at the next shell.
 *
 * Values are the mover's win probability, so a decision's EV loss is
 * `best - value(chosen action)` in probability points.
 */
import { ITEM_ORDER, type ItemType, type Player, type ShellType } from './items.js';

export type Belt = Record<ItemType, number>;

export interface OracleInput {
  hp: [number, number];
  maxHp: number;
  live: number;
  blank: number;
  turn: Player;
  items: [Belt, Belt];
  sawed: boolean;
  skip: [boolean, boolean];
}

export interface OracleResult {
  /** Win probability of the best legal action. */
  best: number;
  /** Win probability of each legal action, keyed `shoot:self`, `use:beer`. */
  byAction: Map<string, number>;
  states: number;
}

interface OState extends OracleInput {
  known: ShellType | null;
}

interface Budget {
  used: number;
  cap: number;
  depth: number;
}

const REFILL: [number, number] = [2, 2];

function other(p: Player): Player {
  return p === 0 ? 1 : 0;
}

function clone(state: OState): OState {
  return {
    hp: [state.hp[0], state.hp[1]],
    maxHp: state.maxHp,
    live: state.live,
    blank: state.blank,
    turn: state.turn,
    items: [{ ...state.items[0] }, { ...state.items[1] }],
    sawed: state.sawed,
    skip: [state.skip[0], state.skip[1]],
    known: state.known,
  };
}

function canon(s: OState): string {
  const p = s.turn;
  const o = other(p);
  let mine = '';
  let theirs = '';
  for (const item of ITEM_ORDER) {
    mine += s.items[p][item];
    theirs += s.items[o][item];
  }
  return `${s.hp[0]}.${s.hp[1]}.${s.maxHp}.${s.live}.${s.blank}.${p}.${mine}.${theirs}.${
    s.sawed ? 1 : 0
  }${s.skip[0] ? 1 : 0}${s.skip[1] ? 1 : 0}.${s.known ?? '?'}`;
}

function valueOf(s: OState, memo: Map<string, number>, budget: Budget): number {
  if (s.hp[0] <= 0) return s.turn === 0 ? 0 : 1;
  if (s.hp[1] <= 0) return s.turn === 1 ? 0 : 1;
  if (budget.used >= budget.cap) return 0.5;
  if (budget.depth > 400) return 0.5; // guard: never blow the stack

  const key = canon(s);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  budget.used += 1;
  budget.depth += 1;
  try {
    let best = 0;
    for (const [, q] of actionsFor(s, memo, budget)) best = Math.max(best, q);
    memo.set(key, best);
    return best;
  } finally {
    budget.depth -= 1;
  }
}

function refill(s: OState): void {
  if (s.live + s.blank === 0) {
    s.live = REFILL[0];
    s.blank = REFILL[1];
  }
}

function shootValue(
  s: OState,
  target: 'self' | 'opponent',
  shell: ShellType,
  memo: Map<string, number>,
  budget: Budget,
): number {
  const n = clone(s);
  const sawed = s.sawed;
  n.known = null;
  n.sawed = false;
  const victim = target === 'self' ? s.turn : other(s.turn);
  if (shell === 'live') n.live = Math.max(0, n.live - 1);
  else n.blank = Math.max(0, n.blank - 1);

  if (shell === 'live') {
    n.hp[victim] -= sawed ? 2 : 1;
    if (n.hp[victim] <= 0) return victim === s.turn ? 0 : 1;
  }

  const passes = shell === 'live' || target === 'opponent';
  if (passes) {
    const changed = passTurn(n);
    return changed ? 1 - valueOf(n, memo, budget) : valueOf(n, memo, budget);
  }
  refill(n);
  return valueOf(n, memo, budget);
}

function actionValue(
  s: OState,
  target: 'self' | 'opponent',
  memo: Map<string, number>,
  budget: Budget,
): number {
  const total = s.live + s.blank;
  let pLive = total === 0 ? 0.5 : s.live / total;
  if (s.known === 'live') pLive = 1;
  else if (s.known === 'blank') pLive = 0;

  // Never recurse into an outcome that cannot happen: a zero-probability
  // branch would otherwise "consume" a shell that is not there and loop.
  if (pLive >= 1) return shootValue(s, target, 'live', memo, budget);
  if (pLive <= 0) return shootValue(s, target, 'blank', memo, budget);
  return (
    pLive * shootValue(s, target, 'live', memo, budget) +
    (1 - pLive) * shootValue(s, target, 'blank', memo, budget)
  );
}

function passTurn(n: OState): boolean {
  const next = other(n.turn);
  if (n.skip[next]) {
    n.skip[next] = false;
    return false;
  }
  n.turn = next;
  n.known = null;
  return true;
}

function canUse(s: OState, item: ItemType): boolean {
  const p = s.turn;
  const total = s.live + s.blank;
  switch (item) {
    case 'cigarette':
      return s.hp[p] < s.maxHp;
    case 'beer':
    case 'magnifier':
    case 'inverter':
      return total > 0;
    case 'handsaw':
      return !s.sawed;
    case 'handcuffs':
      return !s.skip[other(p)];
    case 'pills':
      return true;
    case 'burner':
      return total >= 2;
    case 'adrenaline':
      return ITEM_ORDER.some((other_) => s.items[other(p)][other_] > 0);
    default:
      return false;
  }
}

/** Applies an item the mover already owns (and already spent). */
function itemValue(
  n: OState,
  item: ItemType,
  memo: Map<string, number>,
  budget: Budget,
): number {
  const p = n.turn;
  const total = n.live + n.blank;
  switch (item) {
    case 'cigarette':
      n.hp[p] = Math.min(n.maxHp, n.hp[p] + 1);
      return valueOf(n, memo, budget);
    case 'beer': {
      if (total === 0) return valueOf(n, memo, budget);
      if (n.live > 0 && n.blank > 0) {
        const pLive = n.live / total;
        const live = clone(n);
        live.live -= 1;
        refill(live);
        const blank = clone(n);
        blank.blank -= 1;
        refill(blank);
        return pLive * valueOf(live, memo, budget) + (1 - pLive) * valueOf(blank, memo, budget);
      }
      const only = clone(n);
      if (n.live > 0) only.live -= 1;
      else only.blank -= 1;
      refill(only);
      return valueOf(only, memo, budget);
    }
    case 'magnifier':
    case 'burner': {
      if (total === 0) return valueOf(n, memo, budget);
      const pLive = n.live / total;
      const seenLive = clone(n);
      seenLive.known = 'live';
      const seenBlank = clone(n);
      seenBlank.known = 'blank';
      return (
        pLive * valueOf(seenLive, memo, budget) + (1 - pLive) * valueOf(seenBlank, memo, budget)
      );
    }
    case 'handsaw':
      n.sawed = true;
      return valueOf(n, memo, budget);
    case 'handcuffs':
      n.skip[other(p)] = true;
      return valueOf(n, memo, budget);
    case 'pills': {
      const heal = clone(n);
      heal.hp[p] = Math.min(n.maxHp, heal.hp[p] + 2);
      const hurt = clone(n);
      hurt.hp[p] -= 1;
      return (
        0.5 * valueOf(heal, memo, budget) +
        0.5 * (hurt.hp[p] <= 0 ? 0 : valueOf(hurt, memo, budget))
      );
    }
    case 'inverter':
      if (n.known === 'live') n.known = 'blank';
      else if (n.known === 'blank') n.known = 'live';
      return valueOf(n, memo, budget);
    case 'adrenaline': {
      let best = 0;
      const victim = other(p);
      for (const stolen of ITEM_ORDER) {
        if (n.items[victim][stolen] <= 0) continue;
        const m = clone(n);
        m.items[victim][stolen] -= 1;
        best = Math.max(best, itemValue(m, stolen, memo, budget));
      }
      return best;
    }
    default:
      return valueOf(n, memo, budget);
  }
}

function actionsFor(
  s: OState,
  memo: Map<string, number>,
  budget: Budget,
): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const p = s.turn;
  out.push(['shoot:self', actionValue(s, 'self', memo, budget)]);
  out.push(['shoot:opponent', actionValue(s, 'opponent', memo, budget)]);
  for (const item of ITEM_ORDER) {
    if (s.items[p][item] <= 0 || !canUse(s, item)) continue;
    const n = clone(s);
    n.items[p][item] -= 1;
    out.push([`use:${item}`, itemValue(n, item, memo, budget)]);
  }
  return out;
}

export function evaluate(input: OracleInput, maxStates = 150_000): OracleResult {
  const root: OState = { ...structuredClone(input), known: null };
  const memo = sharedMemo();
  const budget: Budget = { used: 0, cap: maxStates, depth: 0 };
  const actions = actionsFor(root, memo, budget);
  const byAction = new Map(actions);
  const best = actions.reduce((acc, [, q]) => Math.max(acc, q), 0);
  return { best, byAction, states: budget.used };
}

/**
 * Decisions inside one match revisit almost the same states, so the memo is
 * shared between calls. Values are pure functions of the canonical state.
 */
let cache = new Map<string, number>();

function sharedMemo(): Map<string, number> {
  if (cache.size > 250_000) cache = new Map();
  return cache;
}

/** Test hook: forget cached positions. */
export function resetOracleCache(): void {
  cache = new Map();
}
