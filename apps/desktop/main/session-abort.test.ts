import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleClient, OpenRouterClient } from '@gametable/agent';
import { coup } from '@gametable/games-coup';
import { ResultsStore } from '@gametable/stats';
import type { TableSnapshot } from '../shared/api.js';
import { MatchSession } from './session.js';

describe('cancelling live model requests', () => {
  let dir: string;
  let session: MatchSession;
  let running: Promise<void> | undefined;
  let latest: TableSnapshot;
  const signals: AbortSignal[] = [];
  const errors: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gt-abort-'));
    signals.length = 0;
    errors.length = 0;
  });

  afterEach(async () => {
    session.abortMatch();
    session.setPaused(false);
    await running;
    await rm(dir, { recursive: true, force: true });
  });

  function create(local: boolean) {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init!.signal as AbortSignal;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const client = local
      ? new OpenAICompatibleClient({ baseUrl: 'http://127.0.0.1:11434/v1', fetchImpl })
      : new OpenRouterClient({ apiKey: 'sk-or-test-abort', fetchImpl });
    session = new MatchSession({
      def: coup,
      seats: [
        { id: 's1', name: 'You', kind: 'human' },
        { id: 's2', name: 'Model', kind: 'llm', modelId: 'test/model' },
      ],
      request: { gameId: coup.id, seed: 42, speed: 8, budgetUsd: 1, seats: [
        { name: 'You', kind: 'human' },
        { name: 'Model', kind: 'llm', modelId: 'test/model', provider: local ? 'local' : 'openrouter' },
      ] },
      client,
      store: new ResultsStore(join(dir, 'results.jsonl')),
      saveBundle: async () => undefined,
      send: (snapshot) => { latest = snapshot; },
      sendPreview: () => undefined,
      sendFinished: () => undefined,
      sendError: (message) => errors.push(message),
      sendDebrief: () => undefined,
      debriefModel: null,
    });
    running = session.start();
  }

  for (const local of [false, true]) {
    it(`aborts the ${local ? 'local' : 'OpenRouter'} HTTP request without another move or retry`, async () => {
      create(local);
      session.submit({ type: 'income' });
      await vi.waitFor(() => expect(signals).toHaveLength(1), { interval: 5 });
      session.abortMatch();
      await running;
      expect(signals[0]?.aborted).toBe(true);
      expect(signals).toHaveLength(1);
      expect(latest.status).toBe('aborted');
      expect(latest.eventCount).toBe(1);
      expect(latest.seatHealth[0]?.errors).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  it('rewinds with a fresh signal after cancelling the old request', async () => {
    create(false);
    session.submit({ type: 'income' });
    await vi.waitFor(() => expect(signals).toHaveLength(1), { interval: 5 });
    await session.rewind();
    expect(signals[0]?.aborted).toBe(true);
    expect(latest.eventCount).toBe(0);
    expect(latest.awaitingHuman).toBe(true);
    session.submit({ type: 'income' });
    await vi.waitFor(() => expect(signals).toHaveLength(2), { interval: 5 });
    expect(signals[1]?.aborted).toBe(false);
    session.abortMatch();
    await vi.waitFor(() => expect(signals[1]?.aborted).toBe(true), { interval: 5 });
    expect(errors).toEqual([]);
  });

  it('does not start a paused model request after abort and unpause', async () => {
    create(false);
    session.setPaused(true);
    session.submit({ type: 'income' });
    await vi.waitFor(() => expect(latest.eventCount).toBe(1), { interval: 5 });
    session.abortMatch();
    await running;
    session.setPaused(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(signals).toHaveLength(0);
    expect(latest.eventCount).toBe(1);
  });
});
