/**
 * Minimal, dependency-free OpenRouter client.
 *
 * Only the main process ever holds the API key. Every call is explicit about
 * cost so the UI can meter it, and every failure is typed so the gateway can
 * decide whether an attempt is worth repeating.
 */

import { redact, redactBody } from './redact.js';

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

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
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
  /**
   * Ask the provider to stream and report the whole text so far on every
   * chunk. The final result is identical to a non-streaming call.
   */
  onText?: (textSoFar: string) => void;
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
    this.maxRetries = options.maxRetries ?? 5;
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
    const payload = this.payload(req);

    if (req.onText) return this.stream(req, payload, started);

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

  private payload(req: CompletionRequest): Record<string, unknown> {
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
    return payload;
  }

  /**
   * Server-sent events with the same retry policy as buffered calls. A failed
   * stream is only retried while nothing has been shown; after the first delta
   * a retry would duplicate text, so the error is reported instead.
   */
  private async stream(
    req: CompletionRequest,
    payload: Record<string, unknown>,
    started: number,
  ): Promise<CompletionResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let textSoFar = '';
      const report = (value: string) => {
        textSoFar = value;
        req.onText?.(value);
      };

      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { ...this.headers(), Accept: 'text/event-stream' },
          body: JSON.stringify({ ...payload, stream: true }),
          signal: req.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const retryable = response.status === 429 || response.status >= 500;
          const error = new OpenRouterError(
            redact(`OpenRouter POST /chat/completions failed: ${response.status}`),
            response.status,
            retryable,
            redactBody(text),
          );
          // Some providers reject streaming combined with strict JSON output.
          // A buffered request still gets the answer, just without previews.
          if (!retryable) {
            const { onText: _ignored, ...buffered } = req;
            return this.complete(buffered);
          }
          if (attempt === this.maxRetries) throw error;
          lastError = error;
          await this.sleep(this.retryDelay(response, attempt));
          continue;
        }

        if (!response.body) {
          const { onText: _ignored, ...buffered } = req;
          return this.complete(buffered);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let model = req.model;
        let usage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
        let sawUsage = false;
        let full = '';
        let finished = false;

        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              finished = true;
              break;
            }
            if (!data) continue;
            let chunk: RawStreamChunk;
            try {
              chunk = JSON.parse(data) as RawStreamChunk;
            } catch {
              continue;
            }
            if (chunk.error) {
              throw new OpenRouterError(
                redact(chunk.error.message ?? 'stream failed'),
                chunk.error.code ?? 0,
                false,
              );
            }
            if (chunk.model) model = chunk.model;
            const delta = chunk.choices?.[0]?.delta?.content ?? '';
            if (delta) report(full + delta);
            full += delta;
            if (chunk.usage) {
              sawUsage = true;
              usage = {
                promptTokens: chunk.usage.prompt_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0,
                costUsd: Number(chunk.usage.cost ?? 0),
              };
            }
          }
        }

        if (!sawUsage) {
          usage = {
            promptTokens: usage.promptTokens,
            completionTokens: Math.max(usage.completionTokens, Math.ceil(full.length / 4)),
            costUsd: usage.costUsd,
          };
        }

        return {
          text: full,
          model,
          usage,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') throw error;
        lastError = error;
        if (textSoFar !== '' || attempt === this.maxRetries) throw error;
        if (error instanceof OpenRouterError && !error.retryable) throw error;
        await this.sleep(backoff(attempt));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new OpenRouterError('stream failed', 0, true);
  }

  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = Number(response.headers.get('retry-after'));
    return Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : backoff(attempt);
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
          redact(`OpenRouter ${method} ${path} failed: ${response.status}`),
          response.status,
          retryable,
          redactBody(text),
        );
        if (!retryable || attempt === this.maxRetries) throw error;

        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoff(attempt);
        await this.sleep(delay + Math.floor(Math.random() * 250));
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') throw error;
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
  return Math.min(600 * 2 ** attempt, 10_000);
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

interface RawStreamChunk {
  model?: string;
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
}
