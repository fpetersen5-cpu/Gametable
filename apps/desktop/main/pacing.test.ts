import { describe, expect, it } from 'vitest';
import { turnHoldMs } from './pacing.js';

describe('turnHoldMs', () => {
  it('paces chat by reading length', () => {
    const short = turnHoldMs({ type: 'say', text: 'Hello.' }, 1);
    const long = turnHoldMs({ type: 'say', text: 'x'.repeat(150) }, 1);
    expect(short).toBeGreaterThanOrEqual(1_200);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(6_000);
  });

  it('keeps long lines readable even at 8x', () => {
    expect(turnHoldMs({ type: 'say', text: 'x'.repeat(150) }, 8)).toBeGreaterThanOrEqual(2_700);
  });

  it('keeps mechanical actions short', () => {
    expect(turnHoldMs({ type: 'shoot', target: 'self' }, 1)).toBe(900);
    expect(turnHoldMs({ type: 'pass' }, 1)).toBe(350);
    expect(turnHoldMs({ type: 'shoot', target: 'self' }, 8)).toBe(300);
  });

  it('treats an empty say as a pass', () => {
    expect(turnHoldMs({ type: 'say', text: '   ' }, 1)).toBe(350);
  });

  it('gives a vote a readable rationale even when the model sends none', () => {
    expect(turnHoldMs({ type: 'vote', target: 's2', text: '' }, 1)).toBeGreaterThanOrEqual(1_200);
  });
});
