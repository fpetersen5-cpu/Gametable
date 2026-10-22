import { rm } from 'node:fs/promises';
import { readJsonFile, secureRead, secureWrite } from './secure-file.js';

export type StorageKind = 'keyring' | 'file';

/** The subset of Electron's safeStorage this module needs. */
export interface CryptoBackend {
  isAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * API-key storage.
 *
 * With an OS keyring (libsecret/kwallet, exposed to the Flatpak via
 * org.freedesktop.secrets) the key is stored encrypted with Electron's
 * safeStorage. Without one we fall back to a 0600 file inside the app's private
 * config directory and say so in the UI. A plaintext file from an older build is
 * migrated the first time it is read.
 */
export class SecretStore {
  constructor(
    private readonly encryptedFile: string,
    private readonly plainFile: string,
    private readonly crypto: CryptoBackend,
  ) {}

  private get canEncrypt(): boolean {
    try {
      return this.crypto.isAvailable();
    } catch {
      return false;
    }
  }

  async storageKind(): Promise<StorageKind> {
    if ((await secureRead(this.encryptedFile)) && this.canEncrypt) return 'keyring';
    return 'file';
  }

  async getKey(): Promise<string | null> {
    const encrypted = await secureRead(this.encryptedFile);
    if (encrypted && this.canEncrypt) {
      try {
        const key = this.crypto.decryptString(encrypted).trim();
        return key.length > 0 ? key : null;
      } catch {
        // A different keyring session (or a wiped keyring) cannot decrypt it.
        return null;
      }
    }

    const legacy = await readJsonFile<{ apiKey?: unknown }>(this.plainFile);
    const key = typeof legacy?.apiKey === 'string' && legacy.apiKey.length > 0 ? legacy.apiKey : null;
    if (key && this.canEncrypt) {
      // Migrate in place, then remove the plaintext copy.
      await this.setKey(key);
    }
    return key;
  }

  async setKey(apiKey: string): Promise<StorageKind> {
    if (this.canEncrypt) {
      const encrypted = this.crypto.encryptString(apiKey);
      await secureWrite(this.encryptedFile, encrypted);
      await rm(this.plainFile, { force: true }).catch(() => undefined);
      return 'keyring';
    }
    await secureWrite(this.plainFile, JSON.stringify({ apiKey }));
    return 'file';
  }

  async clear(): Promise<void> {
    await rm(this.encryptedFile, { force: true }).catch(() => undefined);
    await rm(this.plainFile, { force: true }).catch(() => undefined);
  }
}
