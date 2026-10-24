/** Stable categories for provider failures, shared by health, tests and UI. */
export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'context_length'
  | 'schema'
  | 'timeout'
  | 'network'
  | 'model_not_found'
  | 'budget'
  | 'invalid_response'
  | 'unknown';

export const PROVIDER_ERROR_LABEL: Record<ProviderErrorKind, string> = {
  auth: 'authentication',
  rate_limit: 'rate limit',
  context_length: 'context length',
  schema: 'structured output',
  timeout: 'timeout',
  network: 'network',
  model_not_found: 'model unavailable',
  budget: 'budget',
  invalid_response: 'invalid response',
  unknown: 'provider error',
};

/**
 * Classify without depending on a particular client class. Both OpenRouter and
 * local OpenAI-compatible failures carry status/message/cause information.
 */
export function classifyError(error: unknown): ProviderErrorKind {
  const value = error as {
    name?: string;
    message?: string;
    status?: number;
    body?: string;
    cause?: { code?: string; message?: string };
  };
  const message = `${value?.message ?? ''} ${value?.body ?? ''} ${value?.cause?.message ?? ''}`
    .toLowerCase();
  const status = value?.status;
  if (message.includes('budget') || message.includes('spend cap')) return 'budget';
  if (value?.name === 'AbortError' || message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_not_found';
  if (status === 413 || /context length|context window|too many tokens|maximum context/.test(message)) {
    return 'context_length';
  }
  if (status === 429 || /rate.?limit|too many requests/.test(message)) return 'rate_limit';
  if (
    /response_format|json_schema|structured output|invalid schema|schema.*(required|invalid)/.test(
      message,
    )
  ) {
    return 'schema';
  }
  if (/model.*(not found|does not exist|unavailable)|no such model/.test(message)) {
    return 'model_not_found';
  }
  if (
    status === undefined &&
    (/fetch failed|network|econnrefused|enotfound|eai_again|socket|connection/.test(message) ||
      value?.cause?.code !== undefined)
  ) {
    return 'network';
  }
  if (status !== undefined && status >= 500) return 'network';
  if (/invalid (json|response)|did not produce a legal action|empty (reply|response)/.test(message)) {
    return 'invalid_response';
  }
  return 'unknown';
}

export function errorKindLabel(error: unknown): string {
  return PROVIDER_ERROR_LABEL[classifyError(error)];
}
