import { describe, expect, it } from 'vitest';
import type { GameView, ReplayBundle } from '../shared/api';
import { buildTranscript } from './transcript.js';

function view(partial: Partial<GameView>): GameView {
  return {
    gameId: 'mafia',
    seatId: '__all__',
    phase: { id: 'day-talk', label: 'Day — discussion', kind: 'sequential', actor: 's1', actors: ['s1'], round: 1 },
    seats: [
      { id: 's1', name: 'Seat 1', kind: 'bot' },
      { id: 's2', name: 'Seat 2', kind: 'llm', modelId: 'demo/atlas' },
    ],
    data: {},
    briefing: '',
    chat: [],
    legalActions: [],
    terminal: true,
    winners: ['s1'],
    ...partial,
  };
}

const bundle: ReplayBundle = {
  summary: {
    matchId: 'm-test1234',
    gameId: 'mafia',
    gameName: 'Mafia / Werewolf',
    startedAt: 1_700_000_000_000,
    durationMs: 12_300,
    winners: ['s1'],
    winnerNames: ['Seat 1'],
    seats: [
      {
        seatId: 's1',
        name: 'Seat 1',
        kind: 'human',
        role: 'detective',
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        invalidActions: 0,
      },
      {
        seatId: 's2',
        name: 'Seat 2',
        kind: 'llm',
        modelId: 'demo/atlas',
        role: 'mafia',
        costUsd: 0.0042,
        tokensIn: 1200,
        tokensOut: 90,
        invalidActions: 1,
      },
    ],
    totalCostUsd: 0.0042,
    eventCount: 2,
    metrics: { days: 2 },
  },
  seats: [
    { id: 's1', name: 'Seat 1', kind: 'human' },
    { id: 's2', name: 'Seat 2', kind: 'llm', modelId: 'demo/atlas' },
  ],
  seed: 7,
  events: [
    { seq: 0, phaseId: 'day-talk', round: 1, seatId: 's1', action: { type: 'say', text: 's2 is lying' } },
    { seq: 1, phaseId: 'day-vote', round: 1, seatId: 's2', action: { type: 'vote', target: 's1' } },
  ],
  views: [view({})],
  godViews: [
    view({
      chat: [
        { id: 'c1', seatId: 's1', channel: 'public', text: 's2 is lying', phaseId: 'day-talk', round: 1 },
        { id: 'c2', seatId: 's2', channel: 'mafia', text: 'kill s1', phaseId: 'mafia-talk', round: 1 },
      ],
      data: { god: { roles: { s1: 'detective', s2: 'mafia' } } },
    }),
  ],
};

describe('buildTranscript', () => {
  it('writes a readable markdown transcript', () => {
    const markdown = buildTranscript(bundle);
    expect(markdown).toContain('# Mafia / Werewolf — m-test1234');
    expect(markdown).toContain('Result: Seat 1');
    expect(markdown).toContain('| Seat 1 | human |');
    expect(markdown).toContain('detective');
    expect(markdown).toContain('**Seat 1**: s2 is lying');
    expect(markdown).toContain('_(mafia)_: kill s1');
    expect(markdown).toContain('`day-talk`');
    expect(markdown).toContain('vote (target="s1")');
    expect(markdown).toContain('Total cost $0.0042');
  });
});
