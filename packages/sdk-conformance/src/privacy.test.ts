import { describe, expect, it } from 'vitest';
import type { GameDef, GameView } from '@gametable/engine';
import { mines, type MinesState } from './toy-mines.js';
import { seatRoster } from './index.js';
import { assertViewNonInterference } from './privacy.js';

describe('non-interference test sensitivity', () => {
  const before = mines.setup({ seed: 1, seats: seatRoster(3), options: {} });
  const after = structuredClone(before);
  after.flags.s2 = !before.flags.s2;

  it('accepts changes confined to hidden information', () => {
    expect(() => assertViewNonInterference(mines, 's1', before, after)).not.toThrow();
  });

  for (const channel of ['data', 'phase', 'chat', 'briefing', 'legalActions'] as const) {
    it(`rejects a deliberately injected leak in ${channel}`, () => {
      const leaky: GameDef<MinesState> = {
        ...mines,
        view(state, seatId): GameView {
          const safe = mines.view(state, seatId);
          const secret = String(state.flags.s2);
          switch (channel) {
            case 'data': return { ...safe, data: { hiddenFlags: state.flags } };
            case 'phase': return { ...safe, phase: { ...safe.phase, actor: secret } };
            case 'chat': return { ...safe, chat: [{ id: 'x', seatId: 's2', channel: 'public', text: secret, phaseId: 'probe', round: 1 }] };
            case 'briefing': return { ...safe, briefing: secret };
            case 'legalActions': return { ...safe, legalActions: [{ type: 'probe', secret }] };
          }
        },
      };
      expect(() => assertViewNonInterference(leaky, 's1', before, after)).toThrow(/Hidden information/);
    });
  }

  it('also tests a separately implemented briefing hook', () => {
    const leaky = { ...mines, briefing: (state: MinesState) => String(state.flags.s2) };
    expect(() => assertViewNonInterference(leaky, 's1', before, after)).toThrow(/Hidden information/);
  });
});
