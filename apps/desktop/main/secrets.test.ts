import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore, type CryptoBackend } from './secrets.js';

const working: CryptoBackend = {
  isAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain.split('').reverse().join('')}`, 'utf8'),
  decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, '').split('').reverse().join(''),
};

const unavailable: CryptoBackend = {
  isAvailable: () => false,
  encryptString: () => {
    throw new Error('no keyring');
  },
  decryptString: () => {
    throw new Error('no keyring');
  },
};

async function store(backend: CryptoBackend) {
  const dir = await mkdtemp(join(tmpdir(), 'gt-secrets-'));
  return {
    dir,
    store: new SecretStore(join(dir, 'secrets.enc'), join(dir, 'secrets.json'), backend),
  };
}

describe('secret storage', () => {
  it('encrypts the key when a keyring is available', async () => {
    const { dir, store: secrets } = await store(working);
    expect(await secrets.setKey('sk-or-v1-secret')).toBe('keyring');
    expect(await secrets.getKey()).toBe('sk-or-v1-secret');
    expect(await secrets.storageKind()).toBe('keyring');

    const raw = await readFile(join(dir, 'secrets.enc'), 'utf8');
    expect(raw).not.toContain('sk-or-v1-secret');
    expect((await stat(join(dir, 'secrets.enc'))).mode & 0o777).toBe(0o600);
    await expect(readFile(join(dir, 'secrets.json'))).rejects.toThrow();
  });

  it('falls back to a 0600 file without a keyring', async () => {
    const { dir, store: secrets } = await store(unavailable);
    expect(await secrets.setKey('sk-or-v1-plain')).toBe('file');
    expect(await secrets.getKey()).toBe('sk-or-v1-plain');
    expect(await secrets.storageKind()).toBe('file');
    expect((await stat(join(dir, 'secrets.json'))).mode & 0o777).toBe(0o600);
  });

  it('migrates a legacy plaintext key into the keyring', async () => {
    const { dir, store: secrets } = await store(working);
    await writeFile(join(dir, 'secrets.json'), JSON.stringify({ apiKey: 'sk-or-v1-legacy' }), {
      mode: 0o600,
    });
    expect(await secrets.getKey()).toBe('sk-or-v1-legacy');
    await expect(readFile(join(dir, 'secrets.json'))).rejects.toThrow();
    expect(await readFile(join(dir, 'secrets.enc'), 'utf8')).not.toContain('legacy');
  });

  it('returns null when the keyring can no longer decrypt', async () => {
    const { store: secrets } = await store({
      ...working,
      decryptString: () => {
        throw new Error('locked');
      },
    });
    await secrets.setKey('sk-or-v1-x');
    expect(await secrets.getKey()).toBeNull();
  });
});
