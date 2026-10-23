/**
 * Models answer with JSON, so their table talk arrives inside a JSON string.
 * While tokens stream in, pull out the *public* `text` field of the `action`
 * object so the chat can render it as it is being written. Notes and private
 * fields never match: only the first `"text"` after `"action"` is considered.
 */
/** The `type` of the action being written, once it has streamed in. */
export function actionTypePreview(partial: string): string | null {
  const actionAt = partial.indexOf('"action"');
  if (actionAt === -1) return null;
  const typeAt = partial.indexOf('"type"', actionAt);
  if (typeAt === -1) return null;
  const colon = partial.indexOf(':', typeAt + 6);
  if (colon === -1) return null;
  let index = colon + 1;
  while (index < partial.length && /\s/.test(partial[index] ?? '')) index += 1;
  if (partial[index] !== '"') return null;
  index += 1;
  let out = '';
  while (index < partial.length) {
    const character = partial[index] ?? '';
    if (character === '"') return out || null;
    if (character === '\\') {
      const next = partial[index + 1];
      if (next === undefined) return null;
      out += next;
      index += 2;
      continue;
    }
    out += character;
    index += 1;
  }
  return null;
}

export function actionTextPreview(partial: string): string {
  const actionAt = partial.indexOf('"action"');
  if (actionAt === -1) return '';
  const textAt = partial.indexOf('"text"', actionAt);
  if (textAt === -1) return '';
  const colon = partial.indexOf(':', textAt + 6);
  if (colon === -1) return '';

  let index = colon + 1;
  while (index < partial.length && /\s/.test(partial[index] ?? '')) index += 1;
  if (partial[index] !== '"') return '';
  index += 1;

  let out = '';
  while (index < partial.length) {
    const character = partial[index] ?? '';
    if (character === '"') break;
    if (character === '\\') {
      const next = partial[index + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = partial.slice(index + 2, index + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      const escapes: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      out += escapes[next] ?? next;
      index += 2;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}
