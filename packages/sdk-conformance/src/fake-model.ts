import type {
  CompletionClient,
  CompletionRequest,
  CompletionResult,
} from '@gametable/agent';

/**
 * A model that behaves perfectly: it reads the JSON schema generated from the
 * legal actions and returns the first variant. Used by the M2c gate to prove
 * the whole prompt → schema → parse → validate path works for every game
 * without spending a token.
 */
export class FakeModelClient implements CompletionClient {
  calls = 0;

  constructor(private readonly talk = 'I have nothing to add.') {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls += 1;
    const action = firstLegalAction(req.jsonSchema?.schema, this.talk);
    return {
      text: JSON.stringify({ action, notes: 'fake model notes' }),
      model: req.model,
      usage: { promptTokens: 140, completionTokens: 24, costUsd: 0.0003 },
      latencyMs: 1,
    };
  }
}

interface SchemaNode {
  properties?: Record<string, SchemaField>;
  anyOf?: SchemaNode[];
}

interface SchemaField {
  const?: unknown;
  type?: string;
  items?: SchemaField;
  anyOf?: SchemaNode[];
}

export function firstLegalAction(schema: Record<string, unknown> | undefined, talk: string): Record<string, unknown> {
  const root = schema as SchemaNode | undefined;
  const variant = root?.properties?.action?.anyOf?.[0];
  const action: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(variant?.properties ?? {})) {
    const spec = field as SchemaField;
    if (Object.prototype.hasOwnProperty.call(spec, 'const')) action[key] = spec.const;
    else if (spec.type === 'string') action[key] = talk;
    else if (spec.type === 'array') action[key] = [];
    else if (spec.type === 'number') action[key] = 0;
    else action[key] = null;
  }
  return action;
}
