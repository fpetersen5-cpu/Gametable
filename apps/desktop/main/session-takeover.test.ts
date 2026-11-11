import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompletionRequest, CompletionResult } from '@gametable/agent';
import type { MatchEvent, Seat } from '@gametable/engine';
import { coup } from '@gametable/games-coup';
import { mafia } from '@gametable/games-mafia';
import { FakeModelClient } from '@gametable/sdk-conformance';
import { ResultsStore } from '@gametable/stats';
import type { MatchSummary, TableSnapshot } from '../shared/api.js';
import { MatchSession, type SessionDeps } from './session.js';

describe('live seat takeover', () => {
  let dir: string;
  let session: MatchSession;
  let running: Promise<void> | undefined;
  let latest: TableSnapshot;
  const errors: string[] = [];
  const calls: Array<{ request: CompletionRequest; finish: () => void }> = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gt-takeover-'));
    calls.length = 0;
    errors.length = 0;
    running = undefined;
  });

  afterEach(async () => {
    session?.abortMatch();
    session?.setPaused(false);
    calls.forEach((call) => call.finish());
    await running;
    await rm(dir, { recursive: true, force: true });
  });

  function create(overrides: Partial<SessionDeps> = {}) {
    const seats: Seat[] = overrides.seats ?? [
      { id: 's1', name: 'You', kind: 'human' },
      { id: 's2', name: 'Model', kind: 'llm', modelId: 'local/model' },
    ];
    session = new MatchSession({
      def: coup, seats,
      request: {
        gameId: coup.id, seed: 42, speed: 8, budgetUsd: 1,
        seats: seats.map((seat) => ({ ...seat, kind: seat.kind === 'human' ? 'human' : 'llm' })),
      },
      client: { complete: (request) => new Promise<CompletionResult>((resolve) => {
        calls.push({ request, finish: () => resolve({
          text: JSON.stringify({ action: { type: 'income' }, notes: 'Remember the previous turn.' }),
          model: request.model,
          usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.01 },
          latencyMs: 1,
        }) });
      }) },
      store: new ResultsStore(join(dir, 'results.jsonl')),
      saveBundle: async () => undefined,
      send: (snapshot) => { latest = snapshot; },
      sendPreview: () => undefined,
      sendFinished: () => undefined,
      sendError: (message) => errors.push(message),
      sendDebrief: () => undefined,
      debriefModel: null,
      pacing: false,
      ...overrides,
    });
    return session;
  }

  async function waitingFor(seatId: string) {
    await vi.waitFor(() => {
      expect(latest.awaitingHuman).toBe(true);
      expect(latest.view.seatId).toBe(seatId);
    }, { timeout: 1_000, interval: 5 });
  }

  it('uses the human controller on the next turn and restores the model when released', async () => {
    create();
    running = session.start();
    await waitingFor('s1');
    session.takeover('s2');
    session.takeover('s2'); // Repeated clicks must not replace an active human request.
    session.submit({ type: 'income' });
    await waitingFor('s2');
    expect(calls).toHaveLength(0);
    expect(latest.humanSeatId).toBe('s2');
    expect(latest.godView).toBeNull();
    session.submit({ type: 'income' });
    await waitingFor('s1');
    session.release('s2');
    session.submit({ type: 'income' });
    await vi.waitFor(() => expect(calls).toHaveLength(1), { interval: 5 });
    calls[0]!.finish();
    await waitingFor('s1');
    expect(latest.eventCount).toBe(4);
    expect(latest.takenOverSeats).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('releases a seat while awaiting its human action, preserving model memory and spend', async () => {
    create();
    running = session.start();
    await waitingFor('s1');
    session.submit({ type: 'income' });
    await vi.waitFor(() => expect(calls).toHaveLength(1), { interval: 5 });
    // The in-flight model decision finishes; control changes for its next decision.
    session.takeover('s2');
    calls[0]!.finish();
    await waitingFor('s1');
    expect(latest.costUsd).toBeCloseTo(0.01);
    session.submit({ type: 'income' });
    await waitingFor('s2');
    session.release('s2');
    await vi.waitFor(() => expect(calls).toHaveLength(2), { interval: 5 });
    expect(latest.awaitingHuman).toBe(false);
    expect(JSON.stringify(calls[1]!.request.messages)).toContain('Remember the previous turn.');
    calls[1]!.finish();
    await waitingFor('s1');
    expect(latest.eventCount).toBe(4);
    expect(latest.costUsd).toBeCloseTo(0.02);
    expect(latest.seatHealth[0]?.calls).toBe(2);
    expect(errors).toEqual([]);
  });

  it('allows a spectator to play a covered seat after taking it over while paused', async () => {
    create({ seats: [
      { id: 's1', name: 'One', kind: 'llm', modelId: 'local/model' },
      { id: 's2', name: 'Two', kind: 'llm', modelId: 'local/model' },
    ] });
    session.setPaused(true);
    running = session.start();
    session.takeover('s1');
    session.setPaused(false);
    await waitingFor('s1');
    expect(latest.spectator).toBe(false);
    expect(latest.humanSeatId).toBe('s1');
    expect(latest.godView).toBeNull();
    expect(latest.view.legalActions).toContainEqual({ type: 'income' });
    expect(calls).toHaveLength(0);
    session.release('s1');
    await vi.waitFor(() => expect(calls).toHaveLength(1), { interval: 5 });
    calls[0]!.finish();
    await vi.waitFor(() => expect(latest.eventCount).toBe(1), { interval: 5 });
    expect(latest.spectator).toBe(true);
    expect(errors).toEqual([]);
  });

  it.each([false, true])('queues simultaneous Mafia decisions with an original human seat: %s', async (hasHuman) => {
    const seats: Seat[] = Array.from({ length: 7 }, (_, index) => ({
      id: `s${index + 1}`, name: `Seat ${index + 1}`, kind: 'llm', modelId: 'local/model',
    }));
    const seed = 42;
    let state = mafia.setup({ seed, seats, options: { discussionRounds: 1 } });
    if (hasHuman) {
      seats.find((seat) => mafia.roleOf?.(state, seat.id) === 'mafia')!.kind = 'human';
      state = mafia.setup({ seed, seats, options: { discussionRounds: 1 } });
    }
    const events: MatchEvent[] = [];
    while (mafia.phase(state).id !== 'night-kill') {
      const phase = mafia.phase(state);
      const seatId = phase.actor!;
      const action = mafia.timeoutAction?.(state) ?? mafia.view(state, seatId).legalActions[0]!;
      state = mafia.apply(state, seatId, action);
      events.push({ seq: events.length, phaseId: phase.id, round: phase.round, seatId, action, at: 0 });
      if (events.length > 100) throw new Error('Night kill phase not reached');
    }
    const actors = mafia.phase(state).actors;
    expect(actors).toHaveLength(2);
    const initialCount = events.length;
    let covered = false;
    create({
      def: mafia, seats,
      request: {
        gameId: mafia.id,
        seats: seats.map((seat) => ({ ...seat, kind: seat.kind === 'human' ? 'human' : 'llm' })),
        seed, speed: 8, budgetUsd: 1,
      },
      resume: { seed, state, events },
      send: (snapshot) => {
        latest = snapshot;
        if (!covered) {
          covered = true;
          actors.forEach((seatId) => session.takeover(seatId));
        }
        if (snapshot.eventCount === initialCount + 2 && snapshot.status === 'running') session.abortMatch();
      },
    });
    running = session.start();
    await waitingFor(actors[0]!);
    session.submit(latest.view.legalActions[0]!);
    await waitingFor(actors[1]!);
    expect(latest.humanSeatId).toBe(actors[1]);
    session.submit(latest.view.legalActions[0]!);
    await running;
    expect(latest.eventCount).toBe(initialCount + 2);
    expect(calls).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it('includes the model spend in the final report when the match ends with covered seats', async () => {
    const client = new FakeModelClient();
    const summaries: MatchSummary[] = [];
    let covered = false;
    create({
      seats: [
        { id: 's1', name: 'One', kind: 'llm', modelId: 'local/model' },
        { id: 's2', name: 'Two', kind: 'llm', modelId: 'local/model' },
      ],
      client,
      send: (snapshot) => {
        latest = snapshot;
        if (snapshot.eventCount === 1 && !covered) {
          covered = true;
          session.takeover('s1');
          session.takeover('s2');
        }
        if (snapshot.awaitingHuman) session.submit(snapshot.view.legalActions[0]!);
      },
      sendFinished: (summary) => summaries.push(summary),
    });
    running = session.start();
    await running;
    expect(client.calls).toBe(1);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.seats[0]).toMatchObject({ costUsd: 0.0003, tokensIn: 140, tokensOut: 24 });
    expect(summaries[0]?.totalCostUsd).toBeCloseTo(0.0003, 6);
    expect(latest.costUsd).toBeCloseTo(0.0003, 6);
    expect(errors).toEqual([]);
  });
});
