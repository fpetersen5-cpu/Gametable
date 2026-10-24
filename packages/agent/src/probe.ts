import type { CompletionClient } from './gateway.js';
import { classifyError, type ProviderErrorKind } from './errors.js';
import type { JsonSchemaSpec } from './openrouter.js';
import { parseJsonReply } from './prompt.js';

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  costUsd: number;
  structured: boolean;
  message?: string;
  kind?: ProviderErrorKind;
}

const PROBE_SCHEMA: JsonSchemaSpec = {
  name: 'seat_probe',
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
};

/**
 * A deliberately tiny real call. It verifies connectivity, authentication,
 * timeout behaviour and structured output without leaking a game view or
 * spending meaningful tokens.
 */
export async function probeModel(
  client: CompletionClient,
  model: string,
  timeoutMs = 20_000,
): Promise<ProbeResult> {
  const messages = [
    { role: 'system' as const, content: 'Return a JSON object with the boolean field ok set to true.' },
    { role: 'user' as const, content: 'Reply with the JSON object only.' },
  ];
  const started = Date.now();
  try {
    const result = await client.complete({
      model,
      messages,
      temperature: 0,
      maxTokens: 32,
      jsonSchema: PROBE_SCHEMA,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = parseJsonReply(result.text) as { ok?: unknown } | null;
    if (parsed?.ok !== true) throw new Error('Model did not return {"ok":true}');
    return {
      ok: true,
      latencyMs: result.latencyMs || Date.now() - started,
      costUsd: result.usage.costUsd,
      structured: true,
    };
  } catch (error) {
    const kind = classifyError(error);
    // Some OpenAI-compatible servers reject json_schema. A plain-text reply
    // still proves the seat is reachable; mark it unstructured for the warning.
    if (kind === 'schema') {
      try {
        const result = await client.complete({
          model,
          messages: [
            { role: 'system' as const, content: 'Reply with the single word ready.' },
            { role: 'user' as const, content: 'Ready?' },
          ],
          temperature: 0,
          maxTokens: 16,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!result.text.trim()) throw new Error('Empty probe reply');
        return {
          ok: true,
          latencyMs: result.latencyMs || Date.now() - started,
          costUsd: result.usage.costUsd,
          structured: false,
          message: 'Reachable, but structured JSON output was rejected.',
        };
      } catch (fallbackError) {
        return failure(fallbackError, started);
      }
    }
    return failure(error, started);
  }
}

function failure(error: unknown, started: number): ProbeResult {
  return {
    ok: false,
    latencyMs: Date.now() - started,
    costUsd: 0,
    structured: false,
    kind: classifyError(error),
    message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
  };
}
