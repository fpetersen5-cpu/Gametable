import type { ActionRequest, Controller } from './match.js';
import { Rng } from './rng.js';
import type { GameAction } from './types.js';

/**
 * Picks a uniformly random legal action. Used for conformance runs, CI and for
 * letting people learn a game with no API key.
 */
export class RandomBot implements Controller {
  readonly kind = 'bot' as const;
  private rng: Rng;

  constructor(seed = 1) {
    this.rng = Rng.fromSeed(seed);
  }

  async act(req: ActionRequest): Promise<GameAction> {
    const legal = req.view.legalActions;
    const action = this.rng.pick(legal);
    // Games with table talk offer a free-text action; give the bot a line.
    if ('text' in action && typeof action.text === 'string' && action.text.trim() === '') {
      return { ...action, text: this.rng.pick(TABLE_TALK) };
    }
    return action;
  }
}

const TABLE_TALK = [
  'I am still thinking.',
  'Someone at this table is lying.',
  'I will follow the majority.',
  'That last move was suspicious.',
  'I have nothing to hide.',
  'Let us be careful tonight.',
];

/**
 * An LLM-shaped controller for tests: follows a script and otherwise falls back
 * to random legal actions. Every scripted step is consumed once per seat.
 */
export class ScriptedBot implements Controller {
  readonly kind = 'bot' as const;
  private readonly script: Map<string, GameAction[]>;
  private readonly rng: Rng;

  constructor(script: Record<string, GameAction[]> = {}, seed = 7) {
    this.script = new Map(Object.entries(script));
    this.rng = Rng.fromSeed(seed);
  }

  async act(req: ActionRequest): Promise<GameAction> {
    const queue = this.script.get(req.seat.id);
    const next = queue?.shift();
    return next ?? this.rng.pick(req.view.legalActions);
  }
}
