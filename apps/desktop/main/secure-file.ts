import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * All app writes go through here: 0700 directories, 0600 files, and an atomic
 * temp-file rename so a crash cannot leave a half-written replay or secret.
 */
export async function secureWrite(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, file);
}

export async function secureRead(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  const raw = await secureRead(file);
  if (!raw) return null;
  try {
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    return null;
  }
}
