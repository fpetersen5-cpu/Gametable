import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Seat voices.
 *
 * Chromium's speechSynthesis needs speech-dispatcher, which a Flatpak sandbox
 * does not expose, so the app ships espeak-ng. Each seat gets a stable variant,
 * rate and pitch derived from its id, so the same seat always sounds the same.
 */

const VOICES = [
  'en+m1',
  'en+m2',
  'en+m3',
  'en+m4',
  'en+m5',
  'en+m6',
  'en+m7',
  'en+f1',
  'en+f2',
  'en+f3',
  'en+f4',
  'en+f5',
  'en-gb+m1',
  'en-gb+f2',
  'en-us+m3',
  'en-us+f4',
];

export interface VoiceProfile {
  variant: string;
  rate: number;
  pitch: number;
}

export function voiceFor(seatId: string): VoiceProfile {
  const digest = createHash('sha1').update(seatId).digest();
  const pick = digest[0] ?? 0;
  return {
    variant: VOICES[pick % VOICES.length] as string,
    rate: 150 + ((digest[1] ?? 0) % 45),
    pitch: 35 + ((digest[2] ?? 0) % 45),
  };
}

const cache = new Map<string, string>();
const CACHE_LIMIT = 80;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: 15_000,
        env: {
          ...process.env,
          ESPEAK_DATA_PATH: process.env.ESPEAK_DATA_PATH ?? '/app/share/espeak-ng-data',
        },
      },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message));
        else resolve();
      },
    );
  });
}

/** Returns base64 WAV, or null when there is nothing to say. */
export async function synthesize(text: string, seatId: string): Promise<string | null> {
  const clean = text
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
  if (!clean) return null;

  const profile = voiceFor(seatId);
  const key = `${profile.variant}:${profile.rate}:${profile.pitch}:${clean}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const directory = await mkdtemp(join(tmpdir(), 'gametable-tts-'));
  const file = join(directory, 'speech.wav');
  try {
    await run(process.env.ESPEAK_NG ?? 'espeak-ng', [
      '-v',
      profile.variant,
      '-s',
      String(profile.rate),
      '-p',
      String(profile.pitch),
      '-w',
      file,
      clean,
    ]);
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
