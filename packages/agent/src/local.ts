import {
  OpenRouterClient,
  type CompletionRequest,
  type CompletionResult,
  type ModelInfo,
} from './openrouter.js';

/**
 * An OpenAI-compatible chat-completions endpoint, typically Ollama or another
 * local server. It reuses the hardened transport/streaming/retry implementation
 * but omits OpenRouter-only fields and accepts an unauthenticated endpoint.
 */
export class OpenAICompatibleClient {
  readonly baseUrl: string;
  private readonly inner: OpenRouterClient;

  constructor(options: {
    baseUrl: string;
    apiKey?: string;
    maxRetries?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.baseUrl = normalizeOpenAIBaseUrl(options.baseUrl);
    this.inner = new OpenRouterClient({
      apiKey: options.apiKey?.trim() ?? '',
      allowNoKey: true,
      baseUrl: this.baseUrl,
      providerName: 'Local model server',
      includeUsage: false,
      maxRetries: options.maxRetries ?? 3,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
  }

  complete(req: CompletionRequest): Promise<CompletionResult> {
    // Provider routing is OpenRouter-specific. Local servers must not receive it.
    const { provider: _provider, ...request } = req;
    return this.inner.complete(request);
  }

  listModels(): Promise<ModelInfo[]> {
    return listLocalModels(this.baseUrl);
  }
}

/** Validate and normalize a user-supplied OpenAI-compatible base URL. */
export function normalizeOpenAIBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value || value.length > 300) throw new Error('Enter a local endpoint URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('That local endpoint is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Local endpoints must use http or https');
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Local endpoint must not contain credentials, a query or a fragment');
  }
  return url.toString().replace(/\/$/, '');
}

interface LocalModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  max_model_len?: unknown;
}

/** List models from GET <base>/models, with a short timeout and no OpenRouter fields. */
export async function listLocalModels(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelInfo[]> {
  const base = normalizeOpenAIBaseUrl(baseUrl);
  let response: Response;
  try {
    response = await fetchImpl(`${base}/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the local model server at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) throw new Error(`Local model server returned HTTP ${response.status}`);
  const body = (await response.json().catch(() => null)) as { data?: LocalModel[] } | null;
  if (!body || !Array.isArray(body.data)) throw new Error('Local model server did not return a model list');
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const entry of body.data) {
    if (typeof entry.id !== 'string' || !entry.id.trim() || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const contextLength =
      typeof entry.context_length === 'number'
        ? entry.context_length
        : typeof entry.max_model_len === 'number'
          ? entry.max_model_len
          : 0;
    models.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : entry.id,
      description: `Local model at ${base}`,
      contextLength,
      promptPrice: 0,
      completionPrice: 0,
      // Local servers vary; the gateway falls back if structured output is
      // rejected, so keep these selectable rather than hiding them.
      supportedParameters: ['structured_outputs', 'response_format'],
      free: true,
    });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}
