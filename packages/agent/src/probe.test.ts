import { describe, expect, it } from 'vitest';
import type { CompletionClient } from './gateway.js';
import type { CompletionRequest } from './openrouter.js';
import { probeModel } from './probe.js';
import { OpenRouterError } from './openrouter.js';

function client(run: (req: CompletionRequest) => Promise<string>): CompletionClient {
  return {
    async complete(req) {
      return {
        text: await run(req),
        model: req.model,
        usage: { promptTokens: 2, completionTokens: 2, costUsd: 0.00001 },
        latencyMs: 3,
      };
    },
  };
}

describe('seat probe', () => {
  it('accepts a structured reply', async () => {
    const result = await probeModel(client(async () => '{"ok":true}'), 'demo/model');
    expect(result).toMatchObject({ ok: true, structured: true, costUsd: 0.00001 });
  });

  it('accepts a fenced JSON reply', async () => {
    const result = await probeModel(
      client(async () => '```json\n{"ok":true}\n```'),
      'demo/model',
    );
    expect(result).toMatchObject({ ok: true, structured: true });
  });

  it('retries without schema and marks structured output unavailable', async () => {
    let calls = 0;
    const result = await probeModel(
      client(async (req) => {
        calls += 1;
        if (req.jsonSchema) throw new OpenRouterError('response_format invalid', 400, false);
        return 'ready';
      }),
      'demo/model',
    );
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: true, structured: false });
    expect(result.message).toMatch(/structured JSON/);
  });

  it('returns a classified failure', async () => {
    const result = await probeModel(
      client(async () => {
        throw new OpenRouterError('unauthorized', 401, false);
      }),
      'demo/model',
    );
    expect(result).toMatchObject({ ok: false, kind: 'auth' });
    expect(result.message).toContain('unauthorized');
  });
});
