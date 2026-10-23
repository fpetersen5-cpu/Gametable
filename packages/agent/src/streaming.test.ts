import { describe, expect, it } from 'vitest';
import { OpenRouterClient } from './openrouter.js';

function sse(chunks: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('streaming completions', () => {
  it('streams deltas and reports usage from the final chunk', async () => {
    const seen: string[] = [];
    const fetchImpl = (async () =>
      sse([
        ': OPENROUTER PROCESSING\n\n',
        'data: {"model":"x/y","choices":[{"delta":{"content":"{\\"action\\":"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"{\\"type\\":\\"pass\\"}}"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":7,"cost":0.0002}}\n\n',
        'data: [DONE]\n\n',
      ])) as unknown as typeof fetch;

    const client = new OpenRouterClient({ apiKey: 'sk-or-test', fetchImpl });
    const result = await client.complete({
      model: 'x/y',
      messages: [{ role: 'user', content: 'hi' }],
      onText: (text) => seen.push(text),
    });

    expect(seen).toEqual(['{"action":', '{"action":{"type":"pass"}}']);
    expect(result.text).toBe('{"action":{"type":"pass"}}');
    expect(result.usage).toEqual({ promptTokens: 50, completionTokens: 7, costUsd: 0.0002 });
  });

  it('falls back to a buffered call when the provider rejects streaming', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      if (body.stream) {
        return new Response('{"error":{"message":"stream unsupported"}}', { status: 400 });
      }
      return new Response(
        JSON.stringify({
          model: 'x/y',
          choices: [{ message: { content: '{"action":{}}' } }],
          usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new OpenRouterClient({ apiKey: 'sk-or-test', fetchImpl });
    const result = await client.complete({
      model: 'x/y',
      messages: [{ role: 'user', content: 'hi' }],
      onText: () => undefined,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.stream).toBe(true);
    expect(calls[1]?.stream).toBeUndefined();
    expect(result.text).toBe('{"action":{}}');
  });

  it('aborts a stream when the signal fires', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
          signal.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new OpenRouterClient({ apiKey: 'sk-or-test', fetchImpl });
    const promise = client.complete({
      model: 'x/y',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      onText: () => controller.abort(),
    });
    await expect(promise).rejects.toThrow(/aborted/i);
  });
});
