/**
 * Minimal, dependency-free OpenRouter client.
 *
 * Only the main process ever holds the API key. Every call is explicit about
 * cost so the UI can meter it, and every failure is typed so the gateway can
 * decide whether an attempt is worth repeating.
 */

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  /** USD per token. */
  promptPrice: number;
  /** USD per token. */
  completionPrice: number;
  supportedParameters: string[];
  free: boolean;
}

export interface KeyInfo {
  label?: string;
  /** Credit limit in USD, or null for unlimited. */
  limit: number | null;
  usage: number;
  isFreeTier: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface ProviderPreferences {
  order?: string[];
  allowFallbacks?: boolean;
  requireParameters?: boolean;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonSchema?: JsonSchemaSpec;
  provider?: ProviderPreferences;
  signal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  referer?: string;
  appName?: string;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly options: ClientOptions) {
    if (!options.apiKey.trim()) throw new Error('OpenRouter API key is empty');
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = options.maxRetries ?? 4;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.options.referer) headers['HTTP-Referer'] = this.options.referer;
    if (this.options.appName) headers['X-Title'] = this.options.appName;
    return headers;
  }

  async listModels(): Promise<ModelInfo[]> {
    const body = (await this.request<{ data: RawModel[] }>('GET', '/models')) ;
    return body.data.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      description: m.description ?? '',
      contextLength: m.context_length ?? 0,
      promptPrice: Number(m.pricing?.prompt ?? 0),
      completionPrice: Number(m.pricing?.completion ?? 0),
      supportedParameters: m.supported_parameters ?? [],
      free: m.id.endsWith(':free') || Number(m.pricing?.prompt ?? 1) === 0,
    }));
  }

  async checkKey(): Promise<KeyInfo> {
    for (const path of ['/auth/key', '/key']) {
      try {
        const body = await this.request<{ data: RawKey }>('GET', path);
        return {
          label: body.data?.label,
          limit: body.data?.limit ?? null,
          usage: Number(body.data?.usage ?? 0),
          isFreeTier: Boolean(body.data?.is_free_tier),
        };
      } catch (error) {
        if (!(error instanceof OpenRouterError) || error.status !== 404) throw error;
      }
    }
    throw new OpenRouterError('key endpoint unavailable', 404, false);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const payload: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      usage: { include: true },
    };
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.maxTokens !== undefined) payload.max_tokens = req.maxTokens;
    if (req.jsonSchema) {
      payload.response_format = {
        type: 'json_schema',
        json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema },
      };
    }
    if (req.provider) payload.provider = providerPayload(req.provider);

    const body = await this.request<RawCompletion>('POST', '/chat/completions', payload, req.signal);
    const text = body.choices?.[0]?.message?.content ?? '';
    return {
      text,
      model: body.model ?? req.model,
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        costUsd: Number(body.usage?.cost ?? 0),
      },
      latencyMs: Date.now() - started,
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: this.headers(),
          body: payload === undefined ? undefined : JSON.stringify(payload),
          signal,
        });

        if (response.ok) return (await response.json()) as T;

        const text = await response.text().catch(() => '');
        const retryable = response.status === 429 || response.status >= 500;
        const error = new OpenRouterError(
          `OpenRouter ${method} ${path} failed: ${response.status}`,
          response.status,
          retryable,
          text.slice(0, 500),
        );
        if (!retryable || attempt === this.maxRetries) throw error;

        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoff(attempt);
        await this.sleep(delay + Math.floor(Math.random() * 250));
      } catch (error) {
        if (error instanceof OpenRouterError) {
          lastError = error;
          if (!error.retryable) throw error;
          continue;
        }
        // Network-level failure: worth retrying.
        lastError = error;
        if (attempt === this.maxRetries) break;
        await this.sleep(backoff(attempt));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new OpenRouterError('request failed', 0, true);
  }
}

function backoff(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000);
}

/**
 * OpenRouter's provider preferences are snake_case. Sending camelCase makes
 * the API reject the whole request with "Unrecognized keys", so translate at
 * the HTTP boundary and keep the public option names TypeScript-idiomatic.
 */
export function providerPayload(preferences: ProviderPreferences): Record<string, unknown> {
  return {
    ...(preferences.order ? { order: preferences.order } : {}),
    ...(preferences.allowFallbacks !== undefined
      ? { allow_fallbacks: preferences.allowFallbacks }
      : {}),
    ...(preferences.requireParameters !== undefined
      ? { require_parameters: preferences.requireParameters }
      : {}),
  };
}

interface RawModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

interface RawKey {
  label?: string;
  limit?: number | null;
  usage?: number;
  is_free_tier?: boolean;
}

interface RawCompletion {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}
