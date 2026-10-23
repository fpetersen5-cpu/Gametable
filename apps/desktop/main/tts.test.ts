import { describe, expect, it } from 'vitest';
import { VOICE_PRESETS, speakable, voiceFor } from './tts.js';

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

  it('honours an explicitly chosen speaker', () => {
    expect(voiceFor('s1', 318)).toEqual({ speaker: 318, lengthScale: 0.96 });
    expect(voiceFor('s1', 12)).toEqual({ speaker: 12, lengthScale: 0.98 });
  });

  it('offers distinct, valid presets', () => {
    expect(VOICE_PRESETS.length).toBeGreaterThanOrEqual(10);
    const speakers = new Set(VOICE_PRESETS.map((preset) => preset.speaker));
    expect(speakers.size).toBe(VOICE_PRESETS.length);
    for (const preset of VOICE_PRESETS) {
      expect(preset.speaker).toBeGreaterThanOrEqual(0);
      expect(preset.speaker).toBeLessThan(904);
      expect(preset.lengthScale).toBeGreaterThan(0.85);
      expect(preset.lengthScale).toBeLessThan(1.15);
    }
  });

  it('stays inside the model speaker range for many seats', () => {
    for (let index = 0; index < 2000; index++) {
      const profile = voiceFor(`seat-${index}`);
      expect(profile.speaker).toBeGreaterThanOrEqual(0);
      expect(profile.speaker).toBeLessThan(904);
    }
  });
});
