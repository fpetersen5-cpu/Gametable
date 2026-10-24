import { describe, expect, it } from 'vitest';
import { OpenAICompatibleClient, listLocalModels, normalizeOpenAIBaseUrl } from './local.js';
import { OpenRouterClient } from './openrouter.js';

describe('local OpenAI-compatible endpoints', () => {
  it('normalizes http(s) endpoints and rejects credentials, queries and other schemes', () => {
    expect(normalizeOpenAIBaseUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1');
    expect(normalizeOpenAIBaseUrl('https://models.example/v1')).toBe('https://models.example/v1');
    for (const url of [
      'file:///etc/passwd',
      'http://user:secret@localhost:11434/v1',
      'http://localhost:11434/v1?x=1',
      'http://localhost:11434/v1#fragment',
      'not a url',
    ]) {
      expect(() => normalizeOpenAIBaseUrl(url)).toThrow();
    }
  });

  it('lists Ollama-style models with zero prices', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'zeta:7b', max_model_len: 8192 },
            { id: 'alpha:8b', name: 'Alpha' },
            { id: 'alpha:8b' },
            { object: 'model' },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const models = await listLocalModels('http://127.0.0.1:11434/v1', fetchImpl);
    expect(models.map((model) => model.id)).toEqual(['alpha:8b', 'zeta:7b']);
    expect(models[0]).toMatchObject({ name: 'Alpha', promptPrice: 0, completionPrice: 0, free: true });
    expect(models[1]?.contextLength).toBe(8192);
  });

  it('sends no OpenRouter-only fields or credentials to a local server', async () => {
    let body: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      headers = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          model: 'llama3.1:8b',
          choices: [{ message: { content: '{"action":{"type":"pass"}}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const client = new OpenAICompatibleClient({
      baseUrl: 'http://127.0.0.1:11434/v1',
      fetchImpl,
    });
    const result = await client.complete({
      model: 'llama3.1:8b',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { requireParameters: true },
    });
    expect(result.text).toContain('pass');
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('usage');
    expect(headers.Authorization).toBeUndefined();
  });

  it('falls back to a buffered reply when a local server ignores streaming', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          model: 'm',
          choices: [{ message: { content: '{"action":{"type":"pass"}}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    const client = new OpenAICompatibleClient({
      baseUrl: 'http://127.0.0.1:11434/v1',
      fetchImpl,
    });
    const previews: string[] = [];
    const result = await client.complete({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      onText: (text) => previews.push(text),
    });
    expect(result.text).toContain('pass');
    expect(previews).toEqual([]);
  });

  it('reports unreachable endpoints as a useful error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(listLocalModels('http://127.0.0.1:9/v1', fetchImpl)).rejects.toThrow(
      /Could not reach the local model server/,
    );
  });

  it('retries local calls and calls the retry observer', async () => {
    let calls = 0;
    const retries: number[] = [];
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return new Response('busy', { status: 429 });
      return new Response(
        JSON.stringify({
          model: 'm',
          choices: [{ message: { content: 'ok' } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new OpenRouterClient({
      apiKey: '',
      allowNoKey: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      includeUsage: false,
      fetchImpl,
      sleep: async () => undefined,
      maxRetries: 1,
    });
    const result = await client.complete({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      onRetry: (attempt) => retries.push(attempt),
    });
    expect(result.text).toBe('ok');
    expect(retries).toEqual([0]);
  });
});
