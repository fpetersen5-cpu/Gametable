import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompletionRequest, CompletionResult } from '@gametable/agent';
import type { Seat } from '@gametable/engine';
import { coup } from '@gametable/games-coup';
import { ResultsStore } from '@gametable/stats';
import { MatchSession } from './session.js';
import { skillForGame } from './game-skills.js';
import type { TableSnapshot } from '../shared/api.js';

describe('persistent model memory', () => {
  it('loads and saves memory under each model key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-session-memory-'));
    const seats: Seat[] = [
      { id: 's1', name: 'One', kind: 'llm', modelId: 'local/one' },
      { id: 's2', name: 'Two', kind: 'llm', modelId: 'local/two' },
    ];
    const reads: string[] = [];
    const saves: Array<{ key: string; notes: string }> = [];
    const memory = new Map([['openrouter:local/one', 'PERSISTED-ONE']]);
    const prompts: string[] = [];
    let calls = 0;
    let latest: TableSnapshot | null = null;
    const session = new MatchSession({
      def: coup,
      seats,
      request: {
        gameId: coup.id,
        seed: 42,
        speed: 8,
        budgetUsd: 1,
        seats: seats.map((seat) => ({ name: seat.name, kind: 'llm', modelId: seat.modelId })),
      },
      client: {
        complete: async (request: CompletionRequest): Promise<CompletionResult> => {
          calls += 1;
          prompts.push(JSON.stringify(request.messages));
          return {
            text: JSON.stringify({ action: { type: 'income' }, notes: `NOTE-${calls}` }),
            model: request.model,
            usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001 },
            latencyMs: 1,
          };
        },
      },
      memory: {
        read: (key) => {
          reads.push(key);
          return memory.get(key) ?? '';
        },
        save: (key, notes) => {
          saves.push({ key, notes });
          memory.set(key, notes);
        },
      },
      skill: skillForGame(coup.id),
      store: new ResultsStore(join(dir, 'results.jsonl')),
      saveBundle: async () => undefined,
      send: (snapshot) => {
        latest = snapshot;
      },
      sendPreview: () => undefined,
      sendFinished: () => undefined,
      sendError: () => undefined,
      sendDebrief: () => undefined,
      debriefModel: null,
      pacing: false,
    });
    try {
      void session.start();
      const eventCount = () => (latest as TableSnapshot | null)?.eventCount ?? 0;
      const deadline = Date.now() + 5_000;
      while (eventCount() < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(eventCount()).toBeGreaterThanOrEqual(2);
      expect(reads).toEqual(
        expect.arrayContaining(['openrouter:local/one', 'openrouter:local/two']),
      );
      expect(saves.some((save) => save.key === 'openrouter:local/one' && save.notes.length > 0)).toBe(
        true,
      );
      expect(saves.some((save) => save.key === 'openrouter:local/two' && save.notes.length > 0)).toBe(
        true,
      );
      expect(prompts.some((prompt) => prompt.includes('PERSISTED-ONE'))).toBe(true);
      // The game skill is shown to the model but never persisted back.
      expect(prompts.some((prompt) => prompt.includes('COUP MEMORY SKILL'))).toBe(true);
      expect(prompts.some((prompt) => prompt.includes('[skill: Coup]'))).toBe(true);
      expect(saves.every((save) => !save.notes.includes('COUP MEMORY SKILL'))).toBe(true);
      expect(saves.every((save) => !save.notes.includes('[skill:'))).toBe(true);
    } finally {
      session.abortMatch();
    }
  }, 15_000);

  it('injects the start prompt for a model with no stored notes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-session-skill-'));
    const seats: Seat[] = [
      { id: 's1', name: 'One', kind: 'llm', modelId: 'local/one' },
      { id: 's2', name: 'Two', kind: 'llm', modelId: 'local/two' },
    ];
    const prompts: string[] = [];
    let latest: TableSnapshot | null = null;
    const session = new MatchSession({
      def: coup,
      seats,
      request: {
        gameId: coup.id,
        seed: 42,
        speed: 8,
        budgetUsd: 1,
        seats: seats.map((seat) => ({ name: seat.name, kind: 'llm', modelId: seat.modelId })),
      },
      client: {
        complete: async (request: CompletionRequest): Promise<CompletionResult> => {
          prompts.push(JSON.stringify(request.messages));
          return {
            text: JSON.stringify({ action: { type: 'income' }, notes: 'fresh note' }),
            model: request.model,
            usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001 },
            latencyMs: 1,
          };
        },
      },
      memory: { read: () => '', save: () => undefined },
      skill: skillForGame(coup.id),
      store: new ResultsStore(join(dir, 'results.jsonl')),
      saveBundle: async () => undefined,
      send: (snapshot) => {
        latest = snapshot;
      },
      sendPreview: () => undefined,
      sendFinished: () => undefined,
      sendError: () => undefined,
      sendDebrief: () => undefined,
      debriefModel: null,
      pacing: false,
    });
    try {
      void session.start();
      const deadline = Date.now() + 5_000;
      while (prompts.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const skill = skillForGame(coup.id);
      expect(prompts.length).toBeGreaterThan(0);
      expect(prompts.some((prompt) => prompt.includes('You have no notes from previous Coup games yet'))).toBe(true);
      expect(prompts.some((prompt) => prompt.includes('COUP MEMORY SKILL'))).toBe(true);
    } finally {
      session.abortMatch();
    }
  }, 15_000);
});
