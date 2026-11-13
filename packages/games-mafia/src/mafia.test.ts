import { describe, expect, it } from 'vitest';
import { IllegalAction, RandomBot, findLeaks, matchAction, replay, runMatch, type ActionRequest, type GameDef, type Seat } from '@gametable/engine';
import { runGatewayRoundTrip } from '@gametable/sdk-conformance';
import { legalActionsFor, mafia, type MafiaState, type Role, type StepId } from './index.js';

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
  state.passesInRow = 0;
  state.speechesToday = 0;
  state.talkQueue =
    steps[0] === 'day-talk'
      ? [...state.alive]
      : steps[0] === 'mafia-talk'
        ? state.alive.filter((id) => state.roles[id] === 'mafia')
        : [];
  state.voteQueue =
    steps[0] === 'day-vote' || steps[0] === 'runoff' ? [...state.alive] : [];
  state.over = null;
  return state;
}

/** Votes happen one seat at a time in a shuffled order; drive it to the end. */
function voteAll(state: MafiaState, choose: (actor: string) => string): MafiaState {
  let current = state;
  let guard = 0;
  while ((current.steps[0] === 'day-vote' || current.steps[0] === 'runoff') && guard++ < 30) {
    const actor = mafia.phase(current).actor;
    if (!actor) break;
    const options = mafia.view(current, actor).legalActions;
    const target = choose(actor) || String(options[0]?.target ?? '');
    current = mafia.apply(current, actor, { type: 'vote', target, text: '' });
  }
  return current;
}

const five: Record<string, Role> = {
  s1: 'mafia',
  s2: 'doctor',
  s3: 'villager',
  s4: 'villager',
  s5: 'villager',
};

const withLovers: Record<string, Role> = {
  s1: 'mafia',
  s2: 'doctor',
  s3: 'lover',
  s4: 'lover',
  s5: 'villager',
};

describe('setup', () => {
  it('deals the right shape for 5 seats', () => {
    const state = mafia.setup({ seed: 9, seats: roster(5), options: {} });
    const roles = Object.values(state.roles);
    expect(roles.filter((r) => r === 'mafia')).toHaveLength(1);
    expect(roles.filter((r) => r === 'doctor')).toHaveLength(1);
    expect(roles.filter((r) => r === 'lover')).toHaveLength(2);
    expect(roles.filter((r) => r === 'villager')).toHaveLength(1);
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
    expect(roles.filter((r) => r === 'lover')).toHaveLength(2);
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

  it('does not reveal the role of a night kill', () => {
    const state = position(five, ['night-kill', 'dawn', 'day-talk', 'day-vote']);
    const killed = mafia.apply(state, 's1', { type: 'kill', target: 's3' });
    const log = killed.log.join(' ');
    expect(log).toMatch(/Seat 3 was killed in the night\./);
    expect(log).not.toMatch(/They were the/);
    expect(log).not.toMatch(/Seat 3.*villager/);

    const view = mafia.view(killed, 's4').data as { log: string[] };
    expect(view.log.join(' ')).not.toMatch(/They were the/);
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
  it('seats take multiple turns and the day ends when everyone passes', () => {
    let state = position(five, ['day-talk', 'day-vote']);

    state = mafia.apply(state, 's1', { type: 'say', text: 's3, explain yourself.', to: 's3' });
    expect(state.chat[0]?.to).toBe('s3');
    expect(mafia.phase(state).actor).toBe('s3');

    state = mafia.apply(state, 's3', { type: 'say', text: 'Nothing to explain.' });
    // s1 is requeued and can speak again later.
    expect(state.talkQueue).toContain('s1');

    for (const seat of state.talkQueue) {
      state = mafia.apply(state, seat, { type: 'pass' });
    }
    expect(state.steps[0]).toBe('day-vote');
    expect(state.chat).toHaveLength(2);
    expect(state.chat.every((line) => line.channel === 'public')).toBe(true);
  });

  it('a seat can speak again after others have spoken', () => {
    let state = position(five, ['day-talk', 'day-vote']);
    state = mafia.apply(state, 's1', { type: 'say', text: 'First thought.' });
    for (const seat of ['s2', 's3', 's4', 's5']) {
      state = mafia.apply(state, seat, { type: 'say', text: 'Noted.' });
    }
    expect(mafia.phase(state).actor).toBe('s1');
    state = mafia.apply(state, 's1', { type: 'say', text: 'Second thought.' });
    expect(state.chat.filter((line) => line.seatId === 's1')).toHaveLength(2);
  });

  it('a passing seat leaves the rotation until someone addresses it', () => {
    let state = position(five, ['day-talk', 'day-vote']);
    state = mafia.apply(state, 's1', { type: 'pass' });
    expect(state.talkQueue).not.toContain('s1');
    expect(mafia.phase(state).actor).toBe('s2');

    state = mafia.apply(state, 's2', { type: 'say', text: 's1, anything to add?', to: 's1' });
    expect(mafia.phase(state).actor).toBe('s1');
  });

  it('an empty say is a pass and adds no chat line', () => {
    let state = position(five, ['day-talk', 'day-vote']);
    state = mafia.apply(state, 's1', { type: 'say', text: '   ' });
    expect(state.chat).toHaveLength(0);
    expect(state.talkQueue).not.toContain('s1');
    expect(mafia.phase(state).actor).toBe('s2');
  });

  it('an empty mafia speech does not add a placeholder line', () => {
    const roles: Record<string, Role> = {
      s1: 'mafia',
      s2: 'mafia',
      s3: 'villager',
      s4: 'villager',
      s5: 'villager',
    };
    let state = position(roles, ['mafia-talk']);
    state = mafia.apply(state, 's1', { type: 'raise' });
    state = mafia.apply(state, 's2', { type: 'raise' });
    const speaker = mafia.phase(state).actor;
    expect(speaker).not.toBeNull();
    state = mafia.apply(state, speaker as string, { type: 'say', text: '  ' });
    expect(state.chat.filter((line) => line.channel === 'mafia')).toHaveLength(0);
  });

  it('a seat leaves the rotation after two self-initiated speeches', () => {
    let state = position(five, ['day-talk', 'day-vote']);
    state = mafia.apply(state, 's1', { type: 'say', text: 'First.' });
    expect(state.talkQueue).toContain('s1');

    for (const seat of ['s2', 's3', 's4', 's5']) {
      state = mafia.apply(state, seat, { type: 'pass' });
    }
    expect(mafia.phase(state).actor).toBe('s1');
    state = mafia.apply(state, 's1', { type: 'say', text: 'Second.' });
    expect(state.talkQueue).not.toContain('s1');
  });

  it('an addressed seat can speak beyond the cap', () => {
    let state = position(five, ['day-talk', 'day-vote']);
    state = mafia.apply(state, 's1', { type: 'say', text: 'First.' });
    for (const seat of ['s2', 's3', 's4', 's5']) {
      state = mafia.apply(state, seat, { type: 'say', text: 'Noted.' });
    }
    state = mafia.apply(state, 's1', { type: 'say', text: 'Second.' });
    expect(state.talkQueue).not.toContain('s1');

    state = mafia.apply(state, 's2', { type: 'say', text: 's1, respond?', to: 's1' });
    expect(mafia.phase(state).actor).toBe('s1');
    state = mafia.apply(state, 's1', { type: 'say', text: 'Third.' });
    expect(state.chat.filter((line) => line.seatId === 's1')).toHaveLength(3);
  });

  it('an exact repeat is treated as a pass', () => {
    let state = position(five, ['day-talk', 'day-vote']);
    state = mafia.apply(state, 's1', { type: 'say', text: 'I was with the doctor.' });
    for (const seat of ['s2', 's3', 's4', 's5']) {
      state = mafia.apply(state, seat, { type: 'pass' });
    }
    const before = state.chat.length;
    state = mafia.apply(state, 's1', { type: 'say', text: 'I was with the doctor!' });
    expect(state.chat).toHaveLength(before);
    expect(state.talkQueue).not.toContain('s1');
  });

  it('does not mistake different non-Latin speech for a repeat', () => {
    let state = position(five, ['day-talk', 'day-vote']);
    state = mafia.apply(state, 's1', { type: 'say', text: '村人は嘘をついている。' });
    for (const seat of ['s2', 's3', 's4', 's5']) {
      state = mafia.apply(state, seat, { type: 'pass' });
    }
    const before = state.chat.length;
    state = mafia.apply(state, 's1', { type: 'say', text: '議長は昨夜自分の家にいた。' });
    expect(state.chat).toHaveLength(before + 1);
    expect(state.chat.at(-1)?.text).toBe('議長は昨夜自分の家にいた。');
  });

  it('eliminates the majority target and every voter gets a spoken line', () => {
    const start = position(five, ['day-vote']);
    expect([...start.voteQueue].sort()).toEqual(['s1', 's2', 's3', 's4', 's5']);

    const state = voteAll(start, (actor) => (actor === 's5' ? 's1' : 's5'));
    expect(state.alive).not.toContain('s5');
    expect(state.log.join(' ')).toMatch(/Seat 5 was voted out. They were the villager/);

    const votes = state.chat.filter((line) => line.phaseId === 'day-vote');
    expect(votes).toHaveLength(5);
    expect(votes.every((line) => line.text.trim().length > 0)).toBe(true);
    expect(votes.some((line) => line.text.includes('I vote for Seat 5'))).toBe(true);
  });

  it('a tie goes to a runoff between only the tied seats, and a tied runoff kills nobody', () => {
    const start = position(five, ['day-vote']);
    start.alive = ['s1', 's2', 's3', 's4'];

    // Day vote: s1 and s2 tie on s3/s1. Only s3 and s1 enter the runoff.
    const tied = voteAll(start, (actor) =>
      actor === 's1' || actor === 's2' ? 's3' : 's1',
    );
    expect(tied.alive).toHaveLength(4);
    expect(tied.log.join(' ')).toMatch(/Runoff/);
    const runoffChat = tied.chat.filter((line) => line.phaseId === 'runoff');
    // Only the two tied seats vote in the runoff.
    expect(runoffChat).toHaveLength(2);
    expect(new Set(runoffChat.map((line) => line.seatId))).toEqual(new Set(['s1', 's3']));
    expect(tied.log.join(' ')).toMatch(/Nobody is eliminated/);
  });

  it('a runoff between the tied seats: 1-1 kills nobody, unanimous eliminates', () => {
    const mk = () => {
      const s = position(five, ['day-vote']);
      s.alive = ['s1', 's2', 's3', 's4'];
      return s;
    };
    // Day vote ties s1/s3 (s1 and s3 each get two votes).
    const tie = (s: MafiaState) => {
      s = mafia.apply(s, 's1', { type: 'vote', target: 's3', text: '' });
      s = mafia.apply(s, 's2', { type: 'vote', target: 's3', text: '' });
      s = mafia.apply(s, 's3', { type: 'vote', target: 's1', text: '' });
      s = mafia.apply(s, 's4', { type: 'vote', target: 's1', text: '' });
      return s;
    };
    let state = tie(mk());
    expect(state.steps[0]).toBe('runoff');
    expect([...state.runoff].sort()).toEqual(['s1', 's3']);
    expect([...state.voteQueue].sort()).toEqual(['s1', 's3']);
    // In the runoff only the tied pair votes; split 1-1, nobody is eliminated.
    for (const actor of [...state.voteQueue]) {
      state = mafia.apply(state, actor, {
        type: 'vote',
        target: actor === 's3' ? 's1' : 's3',
        text: '',
      });
    }
    expect(state.log.join(' ')).toMatch(/The runoff is tied/);
    expect(state.alive).toHaveLength(4);

    // A fresh 2-way tie (s1, s3) where the pair splits 1-1 again stays safe.
    let again = tie(mk());
    expect(again.steps[0]).toBe('runoff');
    for (const actor of [...again.voteQueue]) {
      again = mafia.apply(again, actor, {
        type: 'vote',
        target: actor === 's3' ? 's1' : 's3',
        text: '',
      });
    }
    expect(again.log.join(' ')).toMatch(/The runoff is tied/);
    expect(again.alive).toHaveLength(4);

    // A 3-way tie (s1, s3, s4): s3 and s4 vote s1, s1 votes s3 -> s1 is eliminated.
    let third = mk();
    third = mafia.apply(third, 's1', { type: 'vote', target: 's3', text: '' });
    third = mafia.apply(third, 's2', { type: 'vote', target: 's3', text: '' });
    third = mafia.apply(third, 's3', { type: 'vote', target: 's1', text: '' });
    third = mafia.apply(third, 's4', { type: 'vote', target: 's1', text: '' });
    expect(third.steps[0]).toBe('runoff');
    expect([...third.runoff].sort()).toEqual(['s1', 's3']);
    for (const actor of [...third.voteQueue]) {
      third = mafia.apply(third, actor, {
        type: 'vote',
        target: actor === 's3' ? 's1' : 's3',
        text: '',
      });
    }
    expect(third.log.join(' ')).toMatch(/The runoff is tied/);
  });
});

describe('win conditions', () => {
  it('town wins when the last mafia is voted out', () => {
    const roles: Record<string, Role> = { s1: 'mafia', s2: 'villager', s3: 'villager' };
    const state = voteAll(position(roles, ['day-vote'], 3), (actor) =>
      actor === 's1' ? 's2' : 's1',
    );
    expect(state.over).toBe('town');
    expect(mafia.scoring(state).winners.sort()).toEqual(['s2', 's3']);
  });

  it('mafia wins when it equals the town', () => {
    const roles: Record<string, Role> = { s1: 'mafia', s2: 'villager', s3: 'villager' };
    const state = voteAll(position(roles, ['day-vote'], 3), (actor) =>
      actor === 's1' ? 's2' : actor === 's2' ? 's3' : 's2',
    );
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
    const state = voteAll(position(roles, ['day-vote']), (actor) =>
      actor === 's4' ? 's1' : 's4',
    );
    expect(state.over).toBe('jester');
    expect(mafia.scoring(state).winners).toEqual(['s4']);
  });
});

describe('privacy', () => {
  it('no seat sees another seat\'s role or the mafia chat', () => {
    const roles: Record<string, Role> = { s1: 'mafia', s2: 'mafia', s3: 'villager', s4: 'doctor', s5: 'detective' };
    let state = position(roles, ['mafia-talk', 'night-kill']);

    // Both mafia raise a hand; the engine picks one speaker.
    state = mafia.apply(state, 's1', { type: 'raise' });
    state = mafia.apply(state, 's2', { type: 'raise' });
    const speaker = mafia.phase(state).actor as string;
    state = mafia.apply(state, speaker, { type: 'say', text: 'Kill s3 tonight.' });

    const ids = ['s1', 's2', 's3', 's4', 's5'];
    expect(findLeaks(mafia, state, ids)).toEqual([]);
    // Raised hands are mafia-only knowledge.
    expect(JSON.stringify(mafia.view(state, 's3'))).not.toContain('mafiaHands');
    expect(JSON.stringify(mafia.view(state, speaker))).toContain('mafiaHands');
    expect(JSON.stringify(mafia.view(state, 's3'))).not.toContain('Kill s3 tonight');
    expect(JSON.stringify(mafia.view(state, speaker))).toContain('Kill s3 tonight');
  });

  it('the night floor is raise-hand, two minutes, and ends when nobody raises', () => {
    const roles: Record<string, Role> = { s1: 'mafia', s2: 'mafia', s3: 'villager', s4: 'villager', s5: 'villager' };
    let state = position(roles, ['mafia-talk', 'night-kill']);
    expect(mafia.phaseTimeoutMs?.(state)).toBe(120_000);

    // s1 raises, s2 stays quiet: s1 gets the floor.
    state = mafia.apply(state, 's1', { type: 'raise' });
    state = mafia.apply(state, 's2', { type: 'quiet' });
    expect(mafia.phase(state).actor).toBe('s1');
    expect(legalActionsFor(state, 's1').map((a) => a.type)).toEqual(['say']);

    state = mafia.apply(state, 's1', { type: 'say', text: 'I think we should hit s3.' });
    // New hand round: nobody raises, so the kill vote starts.
    state = mafia.apply(state, 's1', { type: 'quiet' });
    state = mafia.apply(state, 's2', { type: 'quiet' });
    expect(state.steps[0]).toBe('night-kill');
  });

  it('rejects an action from a seat that is not acting', () => {
    const state = position(five, ['night-kill']);
    expect(() => mafia.apply(state, 's2', { type: 'kill', target: 's3' })).toThrow(IllegalAction);
  });
});

describe('vote submissions', () => {
  it('accepts a vote with no rationale and fills one in', () => {
    const legal = [{ type: 'vote', target: 's2', text: '' }];
    expect(matchAction(legal, { type: 'vote', target: 's2' })).toEqual({
      type: 'vote',
      target: 's2',
      text: '',
    });
    expect(matchAction(legal, { type: 'vote', target: 's2', text: 'because' })).toEqual({
      type: 'vote',
      target: 's2',
      text: 'because',
    });
  });
});

describe('discussion deadline', () => {
  it('closes the discussion when the phase runs out of time', async () => {
    const timed: GameDef<MafiaState> = {
      ...mafia,
      phaseTimeoutMs: (state) => (state.steps[0] === 'day-talk' ? 30 : null),
    };
    const seats = roster(5);
    const slow = {
      kind: 'bot' as const,
      async act(req: ActionRequest) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return req.view.legalActions[0] as never;
      },
    };
    const controllers = new Map(seats.map((seat) => [seat.id, slow]));
    const result = await runMatch(timed, seats, controllers, {
      seed: 3,
      maxActions: 300,
      options: { discussionRounds: 1 },
    });
    expect(result.events.some((event) => event.action.type === 'close')).toBe(true);
    expect(result.metrics.speeches).toBeLessThan(seats.length);
  });
});

describe('one-turn rewind', () => {
  it('drops one event and puts the same seat back on turn', async () => {
    const seats = roster(7);
    const bots = new Map(seats.map((seat, index) => [seat.id, new RandomBot(index + 1)]));
    const result = await runMatch(mafia, seats, bots, { seed: 9, maxActions: 400 });
    const cut = Math.min(result.events.length, 30);
    expect(cut).toBeGreaterThan(2);
    const removed = result.events[cut - 1] as (typeof result.events)[number];

    const prefix = result.events.slice(0, cut - 1);
    const rewound = replay(mafia, result.seed, seats, prefix, {});
    expect(mafia.phase(rewound).actors).toContain(removed.seatId);

    // Re-applying the dropped action reproduces the original position exactly.
    const reapplied = mafia.apply(rewound, removed.seatId, removed.action);
    const full = replay(mafia, result.seed, seats, result.events.slice(0, cut), {});
    expect(JSON.stringify(reapplied)).toBe(JSON.stringify(full));
  });
});

describe('night floor deadline', () => {
  it('closes the mafia discussion when its two minutes run out', async () => {
    const timed: GameDef<MafiaState> = {
      ...mafia,
      phaseTimeoutMs: (state) => (state.steps[0] === 'mafia-talk' ? 30 : null),
    };
    const seats = roster(7);
    const slow = {
      kind: 'bot' as const,
      async act(req: ActionRequest) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return req.view.legalActions[0] as never;
      },
    };
    const controllers = new Map(seats.map((seat) => [seat.id, slow]));
    const result = await runMatch(timed, seats, controllers, { seed: 5, maxActions: 400 });
    expect(result.events.some((event) => event.action.type === 'close-night-talk')).toBe(true);
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

describe('lovers', () => {
  it('deals exactly two lovers to villagers for every table size', () => {
    for (let count = 5; count <= 11; count += 1) {
      const state = mafia.setup({ seed: count, seats: roster(count), options: {} });
      const roles = Object.values(state.roles);
      expect(roles.filter((role) => role === 'lover')).toHaveLength(2);
      expect(roles.filter((role) => role === 'villager').length).toBeGreaterThanOrEqual(1);
    }
  });

  it('lovers know each other and other seats do not', () => {
    const state = position(withLovers, ['day-talk', 'day-vote']);
    const view = mafia.view(state, 's3');
    const data = view.data as { lover?: string | null; loverName?: string | null };
    expect(data.lover).toBe('s4');
    expect(data.loverName).toBe('Seat 4');
    expect(view.briefing).toContain('Your lover: Seat 4');

    const outsider = mafia.view(state, 's5');
    expect((outsider.data as { lover?: string | null }).lover).toBeUndefined();
    expect(outsider.briefing).not.toContain('Your lover:');
  });

  it('night-killing one lover leaves the other alive and supportive', () => {
    const state = position(withLovers, ['night-kill', 'dawn', 'day-talk', 'day-vote']);
    const killed = mafia.apply(state, 's1', { type: 'kill', target: 's3' });
    expect(killed.alive).not.toContain('s3');
    expect(killed.alive).toContain('s4');
    expect(killed.log.join(' ')).toMatch(/Seat 3 was killed in the night\./);
    expect(killed.log.join(' ')).not.toMatch(/dies of grief/);
    expect(killed.log.join(' ')).not.toMatch(/They were the/);
    expect(killed.over).toBeNull();

    // The surviving lover still knows the partner and can act as town.
    const survivor = mafia.view(killed, 's4');
    expect((survivor.data as { lover?: string | null }).lover).toBeNull();
    expect(survivor.briefing).toContain('(dead)');
    expect(mafia.phase(killed).actors.length).toBeGreaterThan(0);
  });

  it('a surviving lover wins when the town wins even though the partner died at night', () => {
    const roles: Record<string, Role> = {
      s1: 'mafia',
      s2: 'doctor',
      s3: 'lover',
      s4: 'lover',
      s5: 'villager',
    };
    let state = position(roles, ['night-kill', 'dawn', 'day-vote']);
    state = mafia.apply(state, 's1', { type: 'kill', target: 's3' });
    expect(state.alive).toContain('s4');
    state = voteAll(state, (actor) => (actor === 's1' ? 's2' : 's1'));
    expect(state.over).toBe('town');
    const winners = mafia.scoring(state).winners;
    expect(winners).toContain('s4');
    expect(winners).toContain('s3'); // the dead partner shares the win
  });

  it('a dead lover still wins if the partner survived to a town victory', () => {
    // 7 seats, 1 mafia: night-kill lover s3 (partner s4 survives), then vote
    // out the mafia s1 for a town win. Both lovers share the win.
    let state = position(
      { s1: 'mafia', s2: 'doctor', s3: 'lover', s4: 'lover', s5: 'villager', s6: 'villager', s7: 'villager' },
      ['night-kill', 'dawn', 'day-vote'],
      7,
    );
    state.voteQueue = [...state.alive];
    state = mafia.apply(state, 's1', { type: 'kill', target: 's3' });
    expect(state.alive).not.toContain('s3');
    expect(state.alive).toContain('s4');
    // Vote out the mafia s1 for a town win. Drive votes by the current actor.
    let guard = 0;
    while ((state.steps[0] === 'day-vote' || state.steps[0] === 'runoff') && guard++ < 30) {
      const actor = mafia.phase(state).actor!;
      const options = mafia.view(state, actor).legalActions;
      const target = String(options.find((a) => a.target === 's1')?.target ?? options[0]!.target);
      state = mafia.apply(state, actor, { type: 'vote', target, text: '' });
      if (state.over) break;
    }
    expect(state.over).toBe('town');
    const winners = mafia.scoring(state).winners;
    expect(winners).toContain('s3');
    expect(winners).toContain('s4');
  });

  it('voting out one lover kills the other and reveals the voted role', () => {
    const state = voteAll(position(withLovers, ['day-vote']), (actor) => actor === 's3' ? 's4' : 's3');
    expect(state.alive).not.toContain('s3');
    expect(state.alive).not.toContain('s4');
    expect(state.log.join(' ')).toMatch(/Seat 3 was voted out\. They were the lover\./);
    expect(state.log.join(' ')).toMatch(/Seat 4 dies of grief\./);
    expect(state.stats.lynched).toBe(1);
  });

  it('lovers win with the town', () => {
    const state = voteAll(position(withLovers, ['day-vote']), (actor) => actor === 's1' ? 's2' : 's1');
    expect(state.over).toBe('town');
    expect(mafia.scoring(state).winners).toEqual(expect.arrayContaining(['s3', 's4']));
  });

  it('a lover vote-out double death can still give the mafia the win', () => {
    const roles: Record<string, Role> = {
      s1: 'mafia',
      s2: 'mafia',
      s3: 'lover',
      s4: 'lover',
      s5: 'villager',
    };
    let state = position(roles, ['day-vote']);
    while (state.steps[0] === 'day-vote' || state.steps[0] === 'runoff') {
      const actor = mafia.phase(state).actor!;
      const options = mafia.view(state, actor).legalActions;
      const target = String(options.find((a) => a.target === 's3')?.target ?? options[0]!.target);
      state = mafia.apply(state, actor, { type: 'vote', target, text: '' });
      if (state.over) break;
    }
    expect(state.alive).toEqual(['s1', 's2', 's5']);
    expect(state.over).toBe('mafia');
    // The mafia win, so the lovers do not share it.
    expect(mafia.scoring(state).winners.sort()).toEqual(['s1', 's2']);
  });
});

function buckshotView(state: MafiaState, seatId: string): string {
  return JSON.stringify(mafia.view(state, seatId));
}

describe('view purity', () => {
  it('godView copies the roles map', () => {
    const state = mafia.setup({ seed: 1, seats: roster(5), options: {} });
    const view = mafia.godView!(state);
    const roles = (view.data as { god: { roles: Record<string, string> } }).god.roles;
    expect(roles).not.toBe(state.roles);
    const first = Object.keys(state.roles)[0]!;
    const current = state.roles[first]!;
    roles[first] = current === 'jester' ? 'villager' : 'jester';
    expect(state.roles[first]).toBe(current);
  });
});

describe('preview policy', () => {
  it('treats addressed day talk as public and mafia night talk as private', () => {
    const day = position(five, ['day-talk', 'day-vote']);
    expect(mafia.previewIsPublic!(mafia.view(day, 's1'), 'say')).toBe(true);

    const after = mafia.apply(day, 's1', { type: 'say', text: 'Hello', to: 's2' });
    const publicView = mafia.view(after, 's3');
    expect(
      publicView.chat.some(
        (line) => line.text === 'Hello' && line.to === 's2' && line.channel === 'public',
      ),
    ).toBe(true);

    const night = position(
      { s1: 'mafia', s2: 'mafia', s3: 'villager', s4: 'villager', s5: 'villager' },
      ['mafia-talk'],
    );
    expect(mafia.previewIsPublic!(mafia.view(night, 's1'), 'say')).toBe(false);
  });
});
