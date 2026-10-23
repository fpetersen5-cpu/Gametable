import { describe, expect, it } from 'vitest';
import { actionTextPreview } from './preview.js';

describe('streaming chat preview', () => {
  it('extracts a partial text value', () => {
    expect(actionTextPreview('{"action": {"type": "say", "text": "Good mor')).toBe('Good mor');
  });

  it('handles escapes and stops at the closing quote', () => {
    const partial = '{"action":{"type":"say","text":"a \\"quote\\" and\\nnewline"}}';
    expect(actionTextPreview(partial)).toBe('a "quote" and\nnewline');
  });

  it('does not read private notes or fields before the action', () => {
    expect(actionTextPreview('{"notes":"my secret text"')).toBe('');
    expect(actionTextPreview('{"notes":"a","action":{"type":"pass"}}')).toBe('');
  });

  it('stops cleanly on an incomplete unicode escape', () => {
    expect(actionTextPreview('{"action":{"text":"caf\\u00')).toBe('caf');
  });

  it('ignores non-string text fields', () => {
    expect(actionTextPreview('{"action":{"text": 12}}')).toBe('');
  });
});
