import { describe, expect, it } from 'vitest';
import { voiceFor } from './tts.js';

describe('seat voices', () => {
  it('gives the same seat the same voice every time', () => {
    const first = voiceFor('s3');
    expect(voiceFor('s3')).toEqual(first);
    expect(first.rate).toBeGreaterThan(140);
    expect(first.pitch).toBeGreaterThan(30);
  });

  it('spreads seats across many distinct voices', () => {
    const variants = new Set(
      Array.from({ length: 10 }, (_, index) => voiceFor(`s${index + 1}`).variant),
    );
    expect(variants.size).toBeGreaterThan(5);
  });

  it('does not collide on the first ten seats for rate and pitch', () => {
    const profiles = Array.from({ length: 10 }, (_, index) => voiceFor(`s${index + 1}`));
    const signatures = new Set(profiles.map((p) => `${p.variant}:${p.rate}:${p.pitch}`));
    expect(signatures.size).toBe(10);
  });
});
