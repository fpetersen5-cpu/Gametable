import { describe, expect, it } from 'vitest';
import { encodeWav } from './recorder.js';

describe('WAV encoder', () => {
  it('writes a valid mono 16-bit header and payload', () => {
    const wav = encodeWav([new Float32Array([0, 0.5, -0.5])], 16_000);
    const buffer = Buffer.from(wav, 'base64');
    expect(buffer.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buffer.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buffer.readUInt16LE(22)).toBe(1); // mono
    expect(buffer.readUInt32LE(24)).toBe(16_000); // sample rate
    expect(buffer.readUInt16LE(34)).toBe(16);
    expect(buffer.readUInt32LE(40)).toBe(6);
    expect(buffer.length).toBe(44 + 6);
  });

  it('clamps samples to the 16-bit range', () => {
    const wav = encodeWav([new Float32Array([2, -2])], 8_000);
    const buffer = Buffer.from(wav, 'base64');
    expect(buffer.readInt16LE(44)).toBe(0x7fff);
    expect(buffer.readInt16LE(46)).toBe(-0x8000);
  });

  it('concatenates multiple buffers', () => {
    const wav = encodeWav([new Float32Array(100), new Float32Array(50)], 22_050);
    expect(Buffer.from(wav, 'base64').length).toBe(44 + 300);
  });
});
