import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompletionClient, CompletionRequest } from '@gametable/agent';
import { coup } from '@gametable/games-coup';
import { firstLegalAction } from '@gametable/sdk-conformance';
import { ResultsStore } from '@gametable/stats';
import type { MatchSummary, TableSnapshot } from '../shared/api.js';
import { MatchSession, type SessionDeps } from './session.js';

describe('live match budget', () => {
  let dir: string;
  const seats = [
    { id: 's1', name: 'One', kind: 'llm' as const, modelId: 'test/one' },
    { id: 's2', name: 'Two', kind: 'llm' as const, modelId: 'test/two' },
  ];
  let latest: TableSnapshot;
  const calls: CompletionRequest[] = [];
  const errors: string[] = [];
  const summaries: MatchSummary[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gt-session-budget-'));
    calls.length = 0;
    errors.length = 0;
    summaries.length = 0;
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function client(text?: string, cost = 0.125): CompletionClient {
    return { complete: async (req) => {
      calls.push(req);
      return {
        text: text ?? JSON.stringify({ action: firstLegalAction(req.jsonSchema?.schema, 'Test'), notes: '' }),
        model: req.model, usage: { promptTokens: 10, completionTokens: 5, costUsd: cost }, latencyMs: 1,
      };
    } };
  }

  function create(overrides: Partial<SessionDeps> = {}) {
    return new MatchSession({
      def: coup, seats,
      request: { gameId: coup.id, seed: 42, speed: 8, budgetUsd: 0.125, seats },
      client: client(), store: new ResultsStore(join(dir, 'results.jsonl')),
      saveBundle: async () => undefined,
      send: (snapshot) => { latest = snapshot; },
      sendPreview: () => undefined, sendFinished: (summary) => summaries.push(summary),
      sendError: (message) => errors.push(message), sendDebrief: () => undefined, debriefModel: null,
      ...overrides,
    });
  }

  it('starts no second call when the first call exactly consumes the budget', async () => {
    await create().start();
    expect(calls).toHaveLength(1);
    expect(latest.costUsd).toBe(0.125);
    expect(latest.status).toBe('aborted');
    expect(errors.join(' ')).toMatch(/budget/i);
  });

  it('checks the budget before repairing an invalid response and reports its spend', async () => {
    await create({ client: client('not JSON') }).start();
    expect(calls).toHaveLength(1);
    expect(latest.eventCount).toBe(0);
    expect(latest.costUsd).toBe(0.125);
    expect(latest.status).toBe('aborted');
    expect(latest.seatHealth[0]?.errors).toBe(0);
  });

  it('restores the spent budget before the first resumed call', async () => {
    await create({ resume: {
      seed: 42, state: coup.setup({ seed: 42, seats, options: {} }), events: [],
      controllers: { s1: { costUsd: 0.125 } },
    } }).start();
    expect(calls).toHaveLength(0);
    expect(latest.costUsd).toBe(0.125);
    expect(latest.status).toBe('aborted');
  });

  it('restores settled charges even when cancellation preceded seat-counter persistence', async () => {
    await create({ resume: {
      seed: 42, state: coup.setup({ seed: 42, seats, options: {} }), events: [],
      spentUsd: 0.125, controllers: { s1: { costUsd: 0 } },
    } }).start();
    expect(calls).toHaveLength(0);
    expect(latest.costUsd).toBe(0.125);
  });

  it('keeps prior charges when rewinding a model decision', async () => {
    const lineup = [{ ...seats[0]!, kind: 'human' as const }, seats[1]!];
    const session = create({
      seats: lineup,
      request: { gameId: coup.id, seed: 42, speed: 8, budgetUsd: 0.25, seats: lineup },
      client: client('{"action":{"type":"income"},"notes":""}'),
    });
    const running = session.start();
    try {
      session.submit({ type: 'income' });
      await vi.waitFor(() => expect(latest.eventCount).toBe(2), { interval: 5 });
      await session.rewind();
      await vi.waitFor(() => expect(latest.status).toBe('aborted'), { interval: 5 });
      expect(calls).toHaveLength(2);
      expect(latest.costUsd).toBe(0.25);
    } finally {
      session.abortMatch();
      await running;
    }
  });

  it('lets zero-cost calls finish normally', async () => {
    await create({ client: client(undefined, 0) }).start();
    expect(calls.length).toBeGreaterThan(1);
    expect(latest.status).toBe('finished');
    expect(latest.costUsd).toBe(0);
    expect(errors).toEqual([]);
  });

  it('does not buy a debrief when the winning decision uses the remaining budget', async () => {
    let state = coup.setup({ seed: 42, seats, options: {} });
    let count = 0;
    while (!coup.terminal(state)) {
      const actor = coup.phase(state).actor!;
      state = coup.apply(state, actor, coup.view(state, actor).legalActions[0]!);
      count++;
    }
    await create({
      request: { gameId: coup.id, seed: 42, speed: 8, budgetUsd: count * 0.125, seats },
      debriefModel: 'test/one',
    }).start();
    expect(latest.status).toBe('finished');
    expect(calls).toHaveLength(count);
    expect(summaries.at(-1)?.debriefExpected).toBe(false);
  });

  it('checks the shared budget before retrying an empty debrief', async () => {
    const moves = client(undefined, 0);
    await create({
      client: { complete: async (req) => req.jsonSchema
        ? moves.complete(req) : client('').complete(req) },
      debriefModel: 'test/one',
    }).start();
    await vi.waitFor(() => expect(summaries.at(-1)?.debriefExpected).toBe(false), { interval: 5 });
    expect(calls.filter((req) => !req.jsonSchema)).toHaveLength(1);
    expect(latest.costUsd).toBe(0.125);
    expect(latest.status).toBe('finished');
  });
});
