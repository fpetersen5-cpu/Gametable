import { describe, expect, it } from 'vitest';
import { voiceFor } from './tts.js';

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

  it('stays inside the model speaker range for many seats', () => {
    for (let index = 0; index < 2000; index++) {
      const profile = voiceFor(`seat-${index}`);
      expect(profile.speaker).toBeGreaterThanOrEqual(0);
      expect(profile.speaker).toBeLessThan(904);
    }
  });
});
