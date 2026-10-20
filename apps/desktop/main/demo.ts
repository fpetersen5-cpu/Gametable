import type {
  CompletionClient,
  CompletionRequest,
  CompletionResult,
  ModelInfo,
} from '@gametable/agent';

/**
 * Demo mode (GAMETABLE_DEMO=1): a fake model catalogue and a fake transport
 * that answers with a legal action from the generated schema. Used for
 * screenshots, UI testing and demos without spending a token.
 */
export const DEMO_MODELS: ModelInfo[] = [
  {
    id: 'demo/atlas-4',
    name: 'Atlas 4',
    description: 'Demo model',
    contextLength: 200_000,
    promptPrice: 0.000003,
    completionPrice: 0.000015,
    supportedParameters: ['structured_outputs', 'response_format'],
    free: false,
  },
  {
    id: 'demo/marlowe',
    name: 'Marlowe',
    description: 'Demo model',
    contextLength: 128_000,
    promptPrice: 0.000001,
    completionPrice: 0.000004,
    supportedParameters: ['structured_outputs'],
    free: true,
  },
  {
    id: 'demo/vesper',
    name: 'Vesper',
    description: 'Demo model',
    contextLength: 1_000_000,
    promptPrice: 0.000008,
    completionPrice: 0.00003,
    supportedParameters: ['structured_outputs', 'response_format'],
    free: false,
  },
];

const TALK = [
  'I was with the doctor all night. Ask anyone.',
  'Three of us are lying and I intend to find out which.',
  'I will follow the majority, but my gut says seat 2.',
  'That is a very convenient story.',
  'Careful — a quick vote is exactly what the mafia wants.',
  'I have nothing to hide. Investigate me.',
  'Someone changed their story between rounds.',
  'Let us not waste the day on noise.',
];

interface SchemaNode {
  properties?: Record<string, SchemaField>;
  anyOf?: SchemaNode[];
}

interface SchemaField {
  const?: unknown;
  type?: string;
  anyOf?: SchemaNode[];
}

export class DemoClient implements CompletionClient {
  private calls = 0;

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 220));

    const root = req.jsonSchema?.schema as SchemaNode | undefined;
    const variants = root?.properties?.action?.anyOf ?? [];
    const variant = variants[this.calls % Math.max(variants.length, 1)];
    const action: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(variant?.properties ?? {})) {
      const spec = field as SchemaField;
      if (Object.prototype.hasOwnProperty.call(spec, 'const')) action[key] = spec.const;
      else if (spec.type === 'string') action[key] = TALK[this.calls % TALK.length];
      else action[key] = null;
    }

    return {
      text: JSON.stringify({ action, notes: 'demo' }),
      model: req.model,
      usage: {
        promptTokens: 900 + ((this.calls * 137) % 600),
        completionTokens: 40 + ((this.calls * 29) % 80),
        costUsd: 0.00018,
      },
      latencyMs: 140,
    };
  }
}
