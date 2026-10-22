import { describe, expect, it } from 'vitest';
import { redact, redactBody } from './redact.js';

describe('credential redaction', () => {
  it('removes OpenRouter keys', () => {
    expect(redact('failed with sk-or-v1-abcdef1234567890abcdef')).toBe('failed with [redacted]');
  });

  it('removes bearer tokens', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toContain('[redacted]');
  });

  it('removes apiKey fields from error bodies', () => {
    const body = '{"error":{"message":"bad"},"apiKey":"sk-or-v1-1234567890abcdef"}';
    expect(redact(body)).not.toContain('sk-or-');
  });

  it('bounds the body length after redaction', () => {
    expect(redactBody('x'.repeat(1000), 120).length).toBe(120);
  });
});
