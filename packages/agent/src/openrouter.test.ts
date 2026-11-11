import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient, providerPayload } from './openrouter.js';

describe('metadata deadlines', () => {
  afterEach(() => vi.restoreAllMocks());
  for (const method of ['checkKey', 'listModels'] as const) {
    it(`aborts a stalled ${method} request at its default deadline without retrying`, async () => {
      const abort = new AbortController();
      const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
      const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
      const client = new OpenRouterClient({ apiKey: 'test', fetchImpl });
      const result = client[method]();
      const failed = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
      abort.abort(new DOMException('deadline', 'TimeoutError'));
      await failed;
      expect(deadline).toHaveBeenCalledWith(10_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it(`includes rate-limit backoff in the ${method} deadline`, async () => {
      const abort = new AbortController();
      const fetchImpl = vi.fn(async () => new Response('busy', { status: 429, headers: { 'retry-after': '3600' } }));
      const sleep = vi.fn(() => {
        abort.abort(new DOMException('deadline', 'TimeoutError'));
        return new Promise<void>(() => undefined);
      });
      const client = new OpenRouterClient({ apiKey: 'test', fetchImpl, sleep });
      await expect(client[method](abort.signal)).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledTimes(1);
    });
  }
});

describe('provider preferences', () => {
  it('caps Retry-After at 30 seconds', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('busy', { status: 429, headers: { 'retry-after': '3600' } }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = new OpenRouterClient({ apiKey: 'test', fetchImpl, sleep, maxRetries: 1 });
    await expect(client.listModels()).rejects.toMatchObject({ status: 429 });
    const delay = sleep.mock.calls[0]?.[0] as number;
    expect(delay).toBeGreaterThanOrEqual(30_000);
    expect(delay).toBeLessThanOrEqual(30_250);
  });

  it('translates to the snake_case keys OpenRouter expects', () => {
    expect(providerPayload({ requireParameters: true, allowFallbacks: true, order: ['OpenAI'] })).toEqual({
      order: ['OpenAI'],
      allow_fallbacks: true,
      require_parameters: true,
    });
  });

  it('omits keys that were not set', () => {
    expect(providerPayload({ requireParameters: false })).toEqual({ require_parameters: false });
    expect(providerPayload({})).toEqual({});
  });

  it('sends the translated payload over the wire', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          model: 'x/y',
          choices: [{ message: { content: '{}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const client = new OpenRouterClient({ apiKey: 'sk-or-test', fetchImpl });
    await client.complete({
      model: 'x/y',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { requireParameters: true, allowFallbacks: true },
    });

    expect(bodies[0]?.provider).toEqual({
      allow_fallbacks: true,
      require_parameters: true,
    });
  });
});

describe('HTTP cancellation', () => {
  for (const streaming of [false, true]) {
    it(`cancels Retry-After backoff without another request (${streaming ? 'streaming' : 'buffered'})`, async () => {
      const abort = new AbortController();
      const fetchImpl = vi.fn(async () => new Response('rate limited', {
        status: 429, headers: { 'retry-after': '3600' },
      }));
      const client = new OpenRouterClient({ apiKey: 'test', fetchImpl });
      const onRetry = vi.fn(() => queueMicrotask(() => abort.abort()));
      await expect(client.complete({
        model: 'x/y', messages: [], signal: abort.signal, onRetry,
        ...(streaming ? { onText: () => undefined } : {}),
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledTimes(1);
    }, 2_000);

    it(`does not retry a timeout signal as a network error (${streaming ? 'streaming' : 'buffered'})`, async () => {
      const abort = new AbortController();
      const reason = new DOMException('deadline', 'TimeoutError');
      const fetchImpl = vi.fn(async () => { abort.abort(reason); throw reason; });
      const sleep = vi.fn(async () => undefined);
      const client = new OpenRouterClient({ apiKey: 'test', fetchImpl, sleep });
      await expect(client.complete({
        model: 'x/y', messages: [], signal: abort.signal,
        ...(streaming ? { onText: () => undefined } : {}),
      })).rejects.toBe(reason);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  }
});
