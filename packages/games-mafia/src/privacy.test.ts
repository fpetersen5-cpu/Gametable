import { describe, expect, it } from 'vitest';
import { assertViewNonInterference, seatRoster } from '@gametable/sdk-conformance';
import { mafia, type MafiaState, type StepId } from './mafia.js';

function nightState(count = 8): MafiaState {
  const state = mafia.setup({ seed: 3, seats: seatRoster(count), options: {} });
  state.steps = ['night-kill', 'night-save', 'night-check', 'dawn'];
  state.talkQueue = [];
  state.votes = {};
  return state;
}

describe('Mafia hidden-information boundaries', () => {
  it('hides other living roles during day and night, including phase actors', () => {
    for (let count = mafia.minSeats; count <= mafia.maxSeats; count++) {
      const state = nightState(count);
      const viewer = state.alive.find((id) => state.roles[id] === 'villager')!;
      const others = state.alive.filter((id) => id !== viewer);
      for (const step of ['day-talk', 'mafia-talk', 'night-kill', 'night-save', 'night-check'] as StepId[]) {
        const before = structuredClone(state);
        before.steps = [step];
        before.talkQueue = [viewer, ...others];
        for (let i = 1; i < others.length; i++) {
          const changed = structuredClone(before);
          const a = others[0]!;
          const b = others[i]!;
          [changed.roles[a], changed.roles[b]] = [before.roles[b]!, before.roles[a]!];
          assertViewNonInterference(mafia, viewer, before, changed);
        }
      }
    }
  });

  it('keeps kill votes, targets, protection, investigations and private speech out of town views', () => {
    const before = nightState();
    const viewer = before.alive.find((id) => before.roles[id] === 'villager')!;
    const mafioso = before.alive.find((id) => before.roles[id] === 'mafia')!;
    const detective = before.alive.find((id) => before.roles[id] === 'detective')!;
    const changed = structuredClone(before);
    changed.votes[mafioso] = viewer;
    changed.pendingKill = viewer;
    changed.savedTonight = viewer;
    changed.nightHands[mafioso] = true;
    changed.nightSpeaker = mafioso;
    changed.checks[detective] = { [mafioso]: 'mafia' };
    changed.chat.push({
      id: 'private-canary', seatId: mafioso, channel: 'mafia',
      text: 'PRIVATE-NIGHT-CANARY-7831', phaseId: 'mafia-talk', round: 1,
    });
    assertViewNonInterference(mafia, viewer, before, changed);
    expect(JSON.stringify(mafia.view(changed, viewer))).not.toContain('PRIVATE-NIGHT-CANARY-7831');
    expect(JSON.stringify(mafia.view(changed, mafioso))).toContain('PRIVATE-NIGHT-CANARY-7831');
    expect((mafia.view(changed, detective).data as { checks: unknown[] }).checks).toHaveLength(1);
  });

  it('still exposes public votes, deaths and a detective’s own results', () => {
    const before = nightState();
    const viewer = before.alive.find((id) => before.roles[id] === 'detective')!;
    before.steps = ['day-vote'];
    before.voteQueue = [...before.alive];
    const changed = structuredClone(before);
    changed.votes[changed.alive[0]!] = viewer;
    expect(mafia.view(changed, viewer)).not.toEqual(mafia.view(before, viewer));
    changed.checks[viewer] = { [before.alive[0]!]: 'town' };
    expect((mafia.view(changed, viewer).data as { checks: unknown[] }).checks).toHaveLength(1);
  });

  it('does not tell mafia which town seat is doctor or detective', () => {
    const before = nightState();
    const viewer = before.alive.find((id) => before.roles[id] === 'mafia')!;
    const doctor = before.alive.find((id) => before.roles[id] === 'doctor')!;
    const detective = before.alive.find((id) => before.roles[id] === 'detective')!;
    before.steps = ['night-save'];
    const changed = structuredClone(before);
    [changed.roles[doctor], changed.roles[detective]] = ['detective', 'doctor'];
    changed.checks[detective] = { [viewer]: 'mafia' };
    changed.savedTonight = viewer;
    assertViewNonInterference(mafia, viewer, before, changed);
  });
});
