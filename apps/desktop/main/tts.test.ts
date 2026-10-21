import { describe, expect, it } from 'vitest';
import { speakable, voiceFor } from './tts.js';

describe('seat voices', () => {
  it('gives the same seat the same voice every time', () => {
    const first = voiceFor('s3');
    expect(voiceFor('s3')).toEqual(first);
    expect(first.speaker).toBeGreaterThanOrEqual(0);
    expect(first.speaker).toBeLessThan(904);
    expect(first.lengthScale).toBeGreaterThan(0.85);
    expect(first.lengthScale).toBeLessThan(1.15);
  });

  it('gives the first ten seats ten different speakers', () => {
    const speakers = new Set(
      Array.from({ length: 10 }, (_, index) => voiceFor(`s${index + 1}`).speaker),
    );
    expect(speakers.size).toBe(10);
  });

  it('reads long speeches as a sentence-aligned excerpt', () => {
    const short = speakable('Seat three is lying.');
    expect(short).toBe('Seat three is lying.');

    const long = `${'A'.repeat(150)}. ${'B'.repeat(150)} and more text.`;
    const excerpt = speakable(long, 200);
    expect(excerpt.length).toBeLessThan(220);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).toContain('.');
  });

  it('stays inside the model speaker range for many seats', () => {
    for (let index = 0; index < 2000; index++) {
      const profile = voiceFor(`seat-${index}`);
      expect(profile.speaker).toBeGreaterThanOrEqual(0);
      expect(profile.speaker).toBeLessThan(904);
    }
  });
});
