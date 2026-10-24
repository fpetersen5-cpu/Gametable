import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Seat voices, synthesised by Piper (neural TTS) with a 904-speaker model.
 * Each seat maps to a stable speaker id plus a small pace variation, so ten
 * seats sound like ten different people and the same seat always sounds the
 * same.
 */

const PIPER_ROOT = process.env.PIPER_ROOT ?? '/app/piper';
const PIPER = process.env.PIPER_BIN ?? join(PIPER_ROOT, 'piper');
const MODEL = process.env.PIPER_MODEL ?? join(PIPER_ROOT, 'voices', 'en_US-libritts_r-medium.onnx');
const NUM_SPEAKERS = Number(process.env.PIPER_SPEAKERS ?? 904);

export interface VoiceProfile {
  /** Index into the model's speaker set. */
  speaker: number;
  /** Piper's length_scale: >1 slower, <1 faster. */
  lengthScale: number;
}

export interface VoicePreset {
  id: string;
  name: string;
  speaker: number;
  lengthScale: number;
}

/**
 * A small palette of distinct speakers from the model, so seats can be given a
 * voice by hand instead of relying on the automatic hash. Names are neutral:
 * speaker gender is not labelled in the model metadata.
 */
export const VOICE_PRESETS: VoicePreset[] = [
  { id: 'ash', name: 'Ash', speaker: 21, lengthScale: 0.94 },
  { id: 'birch', name: 'Birch', speaker: 93, lengthScale: 1.02 },
  { id: 'cedar', name: 'Cedar', speaker: 167, lengthScale: 0.9 },
  { id: 'dune', name: 'Dune', speaker: 241, lengthScale: 1.06 },
  { id: 'ember', name: 'Ember', speaker: 318, lengthScale: 0.96 },
  { id: 'fern', name: 'Fern', speaker: 402, lengthScale: 1.0 },
  { id: 'grove', name: 'Grove', speaker: 487, lengthScale: 1.04 },
  { id: 'harbor', name: 'Harbor', speaker: 571, lengthScale: 0.92 },
  { id: 'iris', name: 'Iris', speaker: 658, lengthScale: 1.0 },
  { id: 'juniper', name: 'Juniper', speaker: 742, lengthScale: 0.98 },
  { id: 'kestrel', name: 'Kestrel', speaker: 826, lengthScale: 1.05 },
  { id: 'lumen', name: 'Lumen', speaker: 889, lengthScale: 0.94 },
];

export function voiceFor(seatId: string, speaker?: number): VoiceProfile {
  if (typeof speaker === 'number') {
    const preset = VOICE_PRESETS.find((entry) => entry.speaker === speaker);
    const lengthScale = preset?.lengthScale ?? 0.9 + (speaker % 5) * 0.04;
    return { speaker, lengthScale: Number(lengthScale.toFixed(3)) };
  }
  const digest = createHash('sha1').update(seatId).digest();
  const speakerId = (((digest[0] ?? 0) << 8) | (digest[1] ?? 0)) % NUM_SPEAKERS;
  const lengthScale = 0.88 + ((digest[2] ?? 0) % 4) * 0.04;
  return { speaker: speakerId, lengthScale: Number(lengthScale.toFixed(3)) };
}

const cache = new Map<string, string>();
const CACHE_LIMIT = 80;

/** Returns base64 WAV, or null when there is nothing to say. */
export async function synthesize(
  text: string,
  seatId: string,
  speaker?: number,
): Promise<string | null> {
  const clean = speakable(text);
  if (!clean) return null;

  const profile = voiceFor(seatId, speaker);
  const key = `${profile.speaker}:${profile.lengthScale}:${clean}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const directory = await mkdtemp(join(tmpdir(), 'gametable-tts-'));
  const file = join(directory, 'speech.wav');
  try {
    await runPiper(clean, profile, file);
    const wav = await readFile(file);
    const encoded = wav.toString('base64');
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, encoded);
    return encoded;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Long speeches would make the audio lag the table, so read the opening of
 * each message, cut at a sentence boundary.
 */
export function speakable(text: string, limit = 240): string {
  const clean = text
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= limit) return clean;
  const clipped = clean.slice(0, limit);
  const boundary = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('? '),
    clipped.lastIndexOf('! '),
  );
  const cut = boundary > limit * 0.5 ? clipped.slice(0, boundary + 1) : clipped;
  return `${cut.trim()} …`;
}

function runPiper(text: string, profile: VoiceProfile, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      PIPER,
      [
        '--model',
        MODEL,
        '--speaker',
        String(profile.speaker),
        '--length_scale',
        String(profile.lengthScale),
        '--espeak_data',
        process.env.ESPEAK_DATA_PATH ?? join(PIPER_ROOT, 'espeak-ng-data'),
        '--output_file',
        output,
      ],
      {
        // A stuck native synthesizer must not hold a voice request forever.
        timeout: 60_000,
        env: {
          ...process.env,
          LD_LIBRARY_PATH: `${PIPER_ROOT}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`,
          ESPEAK_DATA_PATH: process.env.ESPEAK_DATA_PATH ?? join(PIPER_ROOT, 'espeak-ng-data'),
        },
      },
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-300);
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().slice(-300) || `piper exited with ${code}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(text);
  });
}
