import { describe, expect, it } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonFile, secureRead, secureWrite } from './secure-file.js';

describe('secure files', () => {
  it('writes 0600 files that round-trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-secure-'));
    const file = join(dir, 'nested', 'data.json');
    await secureWrite(file, JSON.stringify({ ok: true }));
    const stats = await stat(file);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(await readJsonFile<{ ok: boolean }>(file)).toEqual({ ok: true });
  });

  it('returns null for a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-secure-'));
    expect(await secureRead(join(dir, 'nope'))).toBeNull();
    expect(await readJsonFile(join(dir, 'nope'))).toBeNull();
  });

  it('returns null for corrupt JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-secure-'));
    const file = join(dir, 'bad.json');
    await secureWrite(file, '{not json');
    expect(await readJsonFile(file)).toBeNull();
  });
});
