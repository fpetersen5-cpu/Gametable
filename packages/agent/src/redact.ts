/**
 * Strip credential-shaped strings before anything reaches a log, an error
 * banner, or a stored record. Defence in depth: the key is only ever sent in an
 * Authorization header, but provider errors and stack traces can echo request
 * material back.
 */
const PATTERNS: RegExp[] = [
  /sk-or-[A-Za-z0-9._-]{8,}/g,
  /sk-[A-Za-z0-9._-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  /["']?api[-_]?key["']?\s*[:=]\s*["'][^"']+["']/gi,
];

export function redact(text: string): string {
  let output = text;
  for (const pattern of PATTERNS) output = output.replace(pattern, '[redacted]');
  return output;
}

/** Redact and bound the length of a provider error body. */
export function redactBody(text: string, limit = 300): string {
  return redact(text).slice(0, limit);
}
