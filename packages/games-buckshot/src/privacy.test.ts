import { describe, expect, it } from 'vitest';
import { assertViewNonInterference, seatRoster } from '@gametable/sdk-conformance';
import { buckshot } from './buckshot.js';

describe('Buckshot hidden-information boundaries', () => {
  for (const viewer of [0, 1] as const) {
    it(`hides shell order, the other belt, knowledge and private log from seat ${viewer}`, () => {
      const before = buckshot.setup({ seed: 7, seats: seatRoster(2), options: {} });
      const other = viewer === 0 ? 1 : 0;
      before.turn = viewer;
      before.chamber = ['live', 'blank', 'live', 'blank'];
      before.items[viewer] = ['magnifier', 'burner', 'adrenaline'];
      before.items[other] = ['beer', 'cigarette'];
      const changed = structuredClone(before);
      changed.chamber.reverse();
      changed.items[other] = ['pills', 'handsaw'];
      changed.knowledge[other] = { top: 'blank', future: [{ offset: 3, shell: 'live' }] };
      changed.log.push({ round: 1, text: 'PRIVATE-PEEK-CANARY-6721', privateTo: other });
      changed.rngState += 1;
      const seatId = before.seats[viewer]!.id;
      assertViewNonInterference(buckshot, seatId, before, changed);
      expect(JSON.stringify(buckshot.view(changed, seatId))).not.toContain('PRIVATE-PEEK-CANARY-6721');
      expect(JSON.stringify(buckshot.view(changed, before.seats[other]!.id))).toContain('PRIVATE-PEEK-CANARY-6721');
      changed.knowledge[viewer].top = 'live';
      expect(buckshot.view(changed, seatId)).not.toEqual(buckshot.view(before, seatId));
    });
  }

  it('permits known shell information but not the order of the remaining unknown shells', () => {
    const before = buckshot.setup({ seed: 7, seats: seatRoster(2), options: {} });
    before.chamber = ['live', 'blank', 'live', 'blank'];
    before.knowledge[0] = { top: 'live', future: [] };
    const changed = structuredClone(before);
    changed.chamber = ['live', 'live', 'blank', 'blank'];
    assertViewNonInterference(buckshot, 's1', before, changed);
  });

  it('exposes the opponent’s stealable items only during the adrenaline choice', () => {
    const before = buckshot.setup({ seed: 7, seats: seatRoster(2), options: {} });
    before.phase = 'adrenaline';
    before.adrenaline = { seat: 0 };
    before.items[1] = ['beer'];
    const changed = structuredClone(before);
    changed.items[1] = ['handsaw'];
    expect(buckshot.view(changed, 's1').legalActions).not.toEqual(buckshot.view(before, 's1').legalActions);
  });
});
