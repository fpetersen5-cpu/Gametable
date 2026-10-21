import { describe, expect, it } from 'vitest';
import { OpenRouterClient, providerPayload } from './openrouter.js';

describe('provider preferences', () => {
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
