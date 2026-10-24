import type { GameAction, GameView } from '../shared/api';

export interface MafiaRole {
  yourRole: string | null;
  yourRoleText: string;
  teammates: string[];
  day: number;
  step: string;
  alive: string[];
  votes: Array<{ voter: string; voterName: string; target: string; targetName: string }>;
  runoff: string[];
  log: string[];
  checks: Array<{ target: string; targetName: string; result: string }>;
  canAct: boolean;
  mafiaHands?: string[];
  mafiaSpeaker?: string | null;
  over: string | null;
  god?: {
    roles: Record<string, string>;
    mafia: string[];
    checks: Array<{ owner: string; target: string; result: string }>;
  };
}

export interface BuckshotData {
  round: number;
  maxHp: number;
  yourHp: number;
  theirHp: number;
  yourItems: string[];
  theirItemCount: number;
  shells: number;
  live: number;
  blank: number;
  youPeeked: { top: string | null; future: Array<{ offset: number; shell: string }> };
  sawed: boolean;
  youAreHandcuffed: boolean;
  roundWins: [number, number];
  yourTurn: boolean;
  phase: string;
  recent: string[];
  over: boolean;
  publicRoles: Record<string, string>;
  god?: {
    hp: [number, number];
    items: [string[], string[]];
    chamber: string[];
    knowledge: Array<{ top: string | null; future: Array<{ offset: number; shell: string }> }>;
  };
}

export function mafiaData(view: GameView): MafiaRole | null {
  const data = view.data as Record<string, unknown> | null;
  return data && typeof data === 'object' && 'yourRole' in data && 'votes' in data
    ? (data as unknown as MafiaRole)
    : null;
}

export function buckshotData(view: GameView): BuckshotData | null {
  const data = view.data as Record<string, unknown> | null;
  return data && typeof data === 'object' && 'yourHp' in data
    ? (data as unknown as BuckshotData)
    : null;
}

export interface CoupPlayer {
  id: string;
  name: string;
  kind: string;
  modelId?: string;
  alive: boolean;
  coins: number;
  influence: number;
}

export interface CoupData {
  coins: number;
  hand: string[];
  yourRole: string | null;
  influence: number;
  players: CoupPlayer[];
  step: string;
  pending: {
    actor: string;
    actorName: string;
    type: string;
    target?: string;
    targetName?: string;
    claimedRole?: string;
  } | null;
  block: {
    blocker: string;
    blockerName: string;
    role: string;
  } | null;
  queue: string[];
  log: string[];
  canAct: boolean;
  over: boolean;
  deckCount: number;
  discard: string[];
  exchangeCards?: string[];
  god?: {
    hands: Record<string, string[]>;
    deck: string[];
    discard: string[];
  };
}

export function coupData(view: GameView): CoupData | null {
  const data = view.data as Record<string, unknown> | null;
  return data && typeof data === 'object' && 'hand' in data && 'deckCount' in data
    ? (data as unknown as CoupData)
    : null;
}

export const ITEM_LABEL: Record<string, { name: string; glyph: string; text: string }> = {
  cigarette: { name: 'Cigarette', glyph: '🚬', text: '+1 health' },
  beer: { name: 'Beer', glyph: '🍺', text: 'Eject the current shell' },
  magnifier: { name: 'Magnifier', glyph: '🔍', text: 'Peek at the current shell' },
  handsaw: { name: 'Handsaw', glyph: '🪚', text: 'Next shot deals 2' },
  handcuffs: { name: 'Handcuffs', glyph: '⛓️', text: 'Opponent skips a turn' },
  pills: { name: 'Pills', glyph: '💊', text: '50/50 heal 2 or lose 1' },
  burner: { name: 'Burner phone', glyph: '📱', text: 'Peek at a future shell' },
  inverter: { name: 'Inverter', glyph: '🔄', text: 'Flip the current shell' },
  adrenaline: { name: 'Adrenaline', glyph: '💉', text: 'Steal and use an item' },
};

export const ROLE_GLYPH: Record<string, string> = {
  villager: '👤',
  mafia: '🔪',
  doctor: '🩺',
  detective: '🔎',
  jester: '🃏',
  player: '🎯',
  dealer: '🎩',
  Duke: '👑',
  Assassin: '🗡️',
  Captain: '⚓',
  Ambassador: '🕊️',
  Contessa: '💃',
};

export function seatColor(seatId: string): string {
  let hash = 0;
  for (const character of seatId) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  return `hsl(${hash} 62% 62%)`;
}

export function shortModel(modelId?: string): string {
  if (!modelId) return '';
  const slash = modelId.indexOf('/');
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}

export function actionTargetName(action: GameAction, seats: Array<{ id: string; name: string }>): string {
  const target = typeof action.target === 'string' ? action.target : '';
  return seats.find((seat) => seat.id === target)?.name ?? target;
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0.0000';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
