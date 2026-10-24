import { describe, expect, it } from 'vitest';
import { classifyError, PROVIDER_ERROR_LABEL } from './errors.js';

describe('provider error classification', () => {
  it('maps transport and API failures to stable kinds', () => {
    expect(classifyError({ status: 401, message: 'no' })).toBe('auth');
    expect(classifyError({ status: 429, message: 'slow down' })).toBe('rate_limit');
    expect(classifyError({ status: 413, message: 'too big' })).toBe('context_length');
    expect(classifyError({ status: 400, message: 'response_format is invalid' })).toBe('schema');
    expect(classifyError({ name: 'AbortError', message: 'aborted' })).toBe('timeout');
    expect(classifyError({ status: 502, message: 'bad gateway' })).toBe('network');
    expect(classifyError(new TypeError('fetch failed'))).toBe('network');
    expect(classifyError(new Error('Arena budget reached.'))).toBe('budget');
    expect(classifyError(new Error('model llama3 does not exist'))).toBe('model_not_found');
    expect(classifyError(new Error('did not produce a legal action'))).toBe('invalid_response');
    expect(classifyError(new Error('surprise'))).toBe('unknown');
  });

  it('has a human label for every kind', () => {
    for (const kind of Object.keys(PROVIDER_ERROR_LABEL)) {
      expect(PROVIDER_ERROR_LABEL[kind as keyof typeof PROVIDER_ERROR_LABEL]).toBeTruthy();
    }
  });
});
