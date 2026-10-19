import { describe, expect, it } from 'vitest';
import { IllegalAction, RandomBot, findLeaks, runMatch, type Seat } from '@gametable/engine';
import { runGatewayRoundTrip } from '@gametable/sdk-conformance';
import { mafia, type MafiaState, type Role, type StepId } from './index.js';

function roster(n: number): Seat[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    name: `Seat ${i + 1}`,
    kind: 'bot',
  }));
}

/** Builds a position with explicit roles and the current step queue. */
function position(roles: Record<string, Role>, steps: StepId[], n = Object.keys(roles).length): MafiaState {
  const state = mafia.setup({ seed: 1, seats: roster(Math.max(5, n)), options: {} });
  state.roles = roles;
  state.alive = Object.keys(roles);
  state.steps = steps;
  state.votes = {};
  state.talkIndex = 0;
  state.talkRound = 0;
  state.over = null;
  return state;
}

const five: Record<string, Role> = {
  s1: 'mafia',
  s2: 'doctor',
  s3: 'villager',
  s4: 'villager',
  s5: 'villager',
};

describe('setup', () => {
  it('deals the right shape for 5 seats', () => {
    const state = mafia.setup({ seed: 9, seats: roster(5), options: {} });
    const roles = Object.values(state.roles);
    expect(roles.filter((r) => r === 'mafia')).toHaveLength(1);
    expect(roles.filter((r) => r === 'doctor')).toHaveLength(1);
    expect(roles.filter((r) => r === 'villager')).toHaveLength(3);
    expect(state.steps[0]).toBe('night-kill');
    const actor = mafia.phase(state).actor;
    expect(actor).toBeTruthy();
    expect(state.roles[actor as string]).toBe('mafia');
  });

  it('deals two mafia, a detective and a jester for 8 seats', () => {
    const state = mafia.setup({ seed: 9, seats: roster(8), options: {} });
    const roles = Object.values(state.roles);
    expect(roles.filter((r) => r === 'mafia')).toHaveLength(2);
    expect(roles.filter((r) => r === 'detective')).toHaveLength(1);
    expect(roles.filter((r) => r === 'jester')).toHaveLength(1);
    expect(state.steps[0]).toBe('mafia-talk');
  });

  it('is deterministic', () => {
    const a = mafia.setup({ seed: 4, seats: roster(7), options: {} });
    const b = mafia.setup({ seed: 4, seats: roster(7), options: {} });
    expect(a.roles).toEqual(b.roles);
    expect(a.steps).toEqual(b.steps);
  });

  it('refuses too few seats', () => {
    expect(() => mafia.setup({ seed: 1, seats: roster(4), options: {} })).toThrow(/5 to 11/);
  });
});

describe('night', () => {
  it('the mafia kill is announced at dawn', () => {
    const state = position(five, ['night-kill', 'dawn', 'day-talk', 'day-vote']);
    const killed = mafia.apply(state, 's1', { type: 'kill', target: 's3' });
    expect(killed.alive).not.toContain('s3');
    expect(killed.steps[0]).toBe('day-talk');
    expect(killed.day).toBe(1);
    expect(killed.log.join(' ')).toMatch(/Seat 3 was killed in the night/);
  });

  it('the doctor can prevent the kill', () => {
    let state = position(five, ['night-kill', 'night-save', 'dawn']);
    state = mafia.apply(state, 's1', { type: 'kill', target: 's3' });
    expect(state.steps[0]).toBe('night-save');
    state = mafia.apply(state, 's2', { type: 'save', target: 's3' });
    expect(state.alive).toContain('s3');
    expect(state.log.join(' ')).toMatch(/attacked but survived/);
  });

  it('a tied mafia vote kills nobody', () => {
    const roles: Record<string, Role> = { s1: 'mafia', s2: 'mafia', s3: 'villager', s4: 'villager', s5: 'villager' };
    let state = position(roles, ['night-kill', 'dawn']);
    state = mafia.apply(state, 's1', { type: 'kill', target: 's3' });
    state = mafia.apply(state, 's2', { type: 'kill', target: 's4' });
    expect(state.alive).toHaveLength(5);
    expect(state.log.join(' ')).toMatch(/could not agree/);
  });

  it('the detective learns a private alignment', () => {
    const roles: Record<string, Role> = {
      s1: 'mafia',
      s2: 'villager',
      s3: 'villager',
      s4: 'detective',
      s5: 'villager',
      s6: 'villager',
    };
    const state = position(roles, ['night-check', 'dawn']);
    const next = mafia.apply(state, 's4', { type: 'investigate', target: 's1' });
    expect(next.checks.s4).toEqual({ s1: 'mafia' });
    expect(buckshotView(next, 's4')).toContain('mafia');
    expect(buckshotView(next, 's2')).not.toContain('s1 is mafia');
  });

  it('a mafia cannot be voted for by the mafia at night', () => {
    const roles: Record<string, Role> = { s1: 'mafia', s2: 'mafia', s3: 'villager', s4: 'villager', s5: 'villager' };
    const state = position(roles, ['night-kill']);
    const legal = mafia.view(state, 's1').legalActions;
    expect(legal.some((a) => a.target === 's2')).toBe(false);
  });
});

describe('day', () => {
  it('everyone speaks in order, then votes', () => {
    let state = position(five, ['day-talk', 'day-vote']);
    state = mafia.apply(state, 's1', { type: 'say', text: 'I suspect s3.' });
    expect(state.steps[0]).toBe('day-talk');
    state = mafia.apply(state, 's2', { type: 'say', text: 'I am the doctor.' });
    state = mafia.apply(state, 's3', { type: 'say', text: 'No you are not.' });
    state = mafia.apply(state, 's4', { type: 'say', text: 'Lynch s1.' });
    state = mafia.apply(state, 's5', { type: 'say', text: 'Agreed.' });
    expect(state.steps[0]).toBe('day-vote');
    expect(state.chat).toHaveLength(5);
    expect(state.chat.every((line) => line.channel === 'public')).toBe(true);
  });

  it('a majority vote eliminates a seat and reveals its role', () => {
    let state = position(five, ['day-vote']);
    for (const seat of ['s1', 's2', 's3', 's4']) {
      state = mafia.apply(state, seat, { type: 'vote', target: 's5' });
    }
    state = mafia.apply(state, 's5', { type: 'vote', target: 's1' });
    expect(state.alive).not.toContain('s5');
    expect(state.log.join(' ')).toMatch(/Seat 5 was voted out. They were the villager/);
  });

  it('a tie goes to a runoff, and a tied runoff kills nobody', () => {
    const start = position(five, ['day-vote']);
    start.alive = ['s1', 's2', 's3', 's4'];

    let tied = start;
    for (const [seat, target] of [
      ['s1', 's3'],
      ['s2', 's3'],
      ['s3', 's1'],
      ['s4', 's1'],
    ] as const) {
      tied = mafia.apply(tied, seat, { type: 'vote', target });
    }
    expect(tied.steps[0]).toBe('runoff');
    expect(tied.alive).toHaveLength(4);

    for (const [seat, target] of [
      ['s1', 's3'],
      ['s2', 's3'],
      ['s3', 's1'],
      ['s4', 's1'],
    ] as const) {
      tied = mafia.apply(tied, seat, { type: 'vote', target });
    }
    expect(tied.alive).toHaveLength(4);
    expect(tied.log.join(' ')).toMatch(/Nobody is eliminated/);
  });
});

describe('win conditions', () => {
  it('town wins when the last mafia is voted out', () => {
    const roles: Record<string, Role> = { s1: 'mafia', s2: 'villager', s3: 'villager' };
    let state = position(roles, ['day-vote'], 3);
    state = mafia.apply(state, 's2', { type: 'vote', target: 's1' });
    state = mafia.apply(state, 's3', { type: 'vote', target: 's1' });
    state = mafia.apply(state, 's1', { type: 'vote', target: 's2' });
    expect(state.over).toBe('town');
    expect(mafia.scoring(state).winners.sort()).toEqual(['s2', 's3']);
  });

  it('mafia wins when it equals the town', () => {
    const roles: Record<string, Role> = { s1: 'mafia', s2: 'villager', s3: 'villager' };
    let state = position(roles, ['day-vote'], 3);
    state = mafia.apply(state, 's1', { type: 'vote', target: 's2' });
    state = mafia.apply(state, 's2', { type: 'vote', target: 's3' });
    state = mafia.apply(state, 's3', { type: 'vote', target: 's2' });
    expect(state.alive).not.toContain('s2');
    expect(state.over).toBe('mafia');
  });

  it('the jester wins by being voted out', () => {
    const roles: Record<string, Role> = {
      s1: 'mafia',
      s2: 'villager',
      s3: 'villager',
      s4: 'jester',
      s5: 'villager',
    };
    let state = position(roles, ['day-vote']);
    for (const seat of ['s1', 's2', 's3', 's5']) {
      state = mafia.apply(state, seat, { type: 'vote', target: 's4' });
    }
    state = mafia.apply(state, 's4', { type: 'vote', target: 's1' });
    expect(state.over).toBe('jester');
    expect(mafia.scoring(state).winners).toEqual(['s4']);
  });
});

describe('privacy', () => {
  it('no seat sees another seat\'s role or the mafia chat', () => {
    const roles: Record<string, Role> = { s1: 'mafia', s2: 'mafia', s3: 'villager', s4: 'doctor', s5: 'detective' };
    let state = position(roles, ['mafia-talk', 'night-kill']);
    state = mafia.apply(state, 's1', { type: 'say', text: 'Kill s3 tonight.' });
    const ids = ['s1', 's2', 's3', 's4', 's5'];
    expect(findLeaks(mafia, state, ids)).toEqual([]);
    expect(JSON.stringify(mafia.view(state, 's3'))).not.toContain('Kill s3 tonight');
    expect(JSON.stringify(mafia.view(state, 's1'))).toContain('Kill s3 tonight');
  });

  it('rejects an action from a seat that is not acting', () => {
    const state = position(five, ['night-kill']);
    expect(() => mafia.apply(state, 's2', { type: 'kill', target: 's3' })).toThrow(IllegalAction);
  });
});

describe('full matches', () => {
  it('plays to completion with random bots', async () => {
    const seats = roster(8);
    const bots = new Map(seats.map((seat, i) => [seat.id, new RandomBot(i + 1)]));
    const result = await runMatch(mafia, seats, bots, { seed: 3, maxActions: 2_000 });
    expect(result.winners.length).toBeGreaterThan(0);
    expect(result.metrics.speeches).toBeGreaterThan(0);
  });

  it('runs a silent day when discussion is disabled', async () => {
    const seats = roster(6);
    const bots = new Map(seats.map((seat, i) => [seat.id, new RandomBot(i + 1)]));
    const result = await runMatch(mafia, seats, bots, {
      seed: 5,
      maxActions: 1_000,
      options: { discussionRounds: 0 },
    });
    expect(result.events.some((event) => event.action.type === 'say')).toBe(false);
    expect(result.winners.length).toBeGreaterThan(0);
  });

  it('a model can speak through the gateway and the words reach the table', async () => {
    const trip = await runGatewayRoundTrip(mafia, { seatCount: 5 });
    const speeches = trip.result.events.filter((event) => event.action.type === 'say');
    expect(speeches.length).toBeGreaterThan(0);
    expect(
      speeches.every((event) => typeof event.action.text === 'string' && event.action.text.length > 0),
    ).toBe(true);
  });
});

function buckshotView(state: MafiaState, seatId: string): string {
  return JSON.stringify(mafia.view(state, seatId));
}
