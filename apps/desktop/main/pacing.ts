import type { GameAction } from '@gametable/engine';

const CHAT_FLOOR_MS = 1_200;
const CHAT_MAX_MS = 6_000;
const ACTION_FLOOR_MS = 300;

function rate(speed: number): number {
  return Math.max(0.5, Math.min(8, Number.isFinite(speed) ? speed : 1));
}

function chatHold(text: string, speed: number): number {
  const length = Math.min(text.trim().length, 400);
  // Reading speed, not the speed multiplier, sets the floor. Even 8x should
  // leave a long line on screen long enough to read.
  const readingFloor = Math.min(CHAT_MAX_MS, Math.max(CHAT_FLOOR_MS, length * 18));
  const scaled = (800 + length * 35) / rate(speed);
  return Math.round(Math.max(readingFloor, Math.min(CHAT_MAX_MS, scaled)));
}

/**
 * How long the table should leave an action on screen before the next model
 * turn starts. Chat is paced by reading length; mechanical actions are shorter.
 */
export function turnHoldMs(action: GameAction, speed: number): number {
  const raw = action.text;
  const text = typeof raw === 'string' ? raw : '';
  if (action.type === 'say') {
    return text.trim()
      ? chatHold(text, speed)
      : Math.max(200, Math.round(350 / rate(speed)));
  }
  if (action.type === 'vote') {
    // The game fills in a rationale when the model sends none.
    return chatHold(text.trim() || 'I vote for someone.', speed);
  }
  if (
    action.type === 'pass' ||
    action.type === 'quiet' ||
    action.type === 'raise' ||
    action.type === 'skip'
  ) {
    return Math.max(200, Math.round(350 / rate(speed)));
  }
  return Math.max(ACTION_FLOOR_MS, Math.round(900 / rate(speed)));
}
