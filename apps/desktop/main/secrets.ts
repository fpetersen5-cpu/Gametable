import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * API-key storage.
 *
 * In the Flatpak build this should be backed by org.freedesktop.portal.Secret
 * (sandbox-correct, no extra permission). Until that is wired up we use a 0600
 * file inside the app's private config directory, which is already
 * `~/.var/app/io.github.takmikill.GameTable/config` under Flatpak.
 *
 * The key never crosses the IPC boundary back to the renderer.
 */
export class SecretStore {
  constructor(private readonly file: string) {}

  async getKey(): Promise<string | null> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as { apiKey?: unknown };
      return typeof parsed.apiKey === 'string' && parsed.apiKey.length > 0 ? parsed.apiKey : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async setKey(apiKey: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify({ apiKey }), { encoding: 'utf8', mode: 0o600 });
    await chmod(this.file, 0o600);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
