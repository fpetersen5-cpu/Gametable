import { describe, expect, it } from 'vitest';
import type { GameView } from '../shared/api';
import { buckshotData, coupData, mafiaData } from './game-data';

function view(data: unknown): GameView {
  return {
    gameId: 'test',
    seatId: 's1',
    phase: { id: 'action', label: 'Action', kind: 'sequential', actor: 's1', actors: ['s1'], round: 1 },
    seats: [{ id: 's1', name: 'Seat 1', kind: 'human' }],
    data,
    briefing: '',
    chat: [],
    legalActions: [],
    terminal: false,
    winners: [],
  };
}

const coupView = view({
  coins: 2,
  hand: ['Duke'],
  yourRole: 'Duke',
  influence: 1,
  deckCount: 3,
  players: [],
  step: 'action',
  pending: null,
  block: null,
  queue: [],
  log: [],
  canAct: true,
  over: false,
  discard: [],
});

const mafiaView = view({
  yourRole: 'mafia',
  votes: [],
  runoff: [],
  log: [],
  checks: [],
  canAct: true,
  over: null,
});

describe('game view shape guards', () => {
  it('never mistakes a Coup view for a Mafia view', () => {
    expect(mafiaData(coupView)).toBeNull();
    expect(buckshotData(coupView)).toBeNull();
    expect(coupData(coupView)?.hand).toEqual(['Duke']);
  });

  it('never mistakes a Mafia view for a Coup view', () => {
    expect(mafiaData(mafiaView)?.yourRole).toBe('mafia');
    expect(coupData(mafiaView)).toBeNull();
    expect(buckshotData(mafiaView)).toBeNull();
  });
});
