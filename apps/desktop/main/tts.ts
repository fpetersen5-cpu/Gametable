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

export function voiceFor(seatId: string): VoiceProfile {
  const digest = createHash('sha1').update(seatId).digest();
  const speaker = (((digest[0] ?? 0) << 8) | (digest[1] ?? 0)) % NUM_SPEAKERS;
  const lengthScale = 0.92 + ((digest[2] ?? 0) % 5) * 0.045;
  return { speaker, lengthScale: Number(lengthScale.toFixed(3)) };
}

const cache = new Map<string, string>();
const CACHE_LIMIT = 80;

/** Returns base64 WAV, or null when there is nothing to say. */
export async function synthesize(text: string, seatId: string): Promise<string | null> {
  const clean = text
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
  if (!clean) return null;

  const profile = voiceFor(seatId);
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
        '--output_file',
        output,
      ],
      {
        env: {
          ...process.env,
          LD_LIBRARY_PATH: `${PIPER_ROOT}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`,
          ESPEAK_DATA_PATH: process.env.ESPEAK_DATA_PATH ?? join(PIPER_ROOT, 'espeak-ng-data'),
        },
      },
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
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
