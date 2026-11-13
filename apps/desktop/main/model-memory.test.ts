import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelMemoryStore } from './model-memory.js';

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'gt-memory-'));
  const file = join(dir, 'model-memory.json');
  const memory = new ModelMemoryStore(file);
  await memory.ready;
  return { dir, file, memory };
}

describe('model memory store', () => {
  it('keeps separate memory for each model and persists it', async () => {
    const { file, memory } = await store();
    memory.set('openrouter:one/model', 'first model notes');
    memory.set('local:http://127.0.0.1:11434/v1:two/model', 'second model notes');
    await memory.flush();

    const reloaded = new ModelMemoryStore(file);
    await reloaded.ready;
    expect(reloaded.get('openrouter:one/model')).toBe('first model notes');
    expect(reloaded.get('local:http://127.0.0.1:11434/v1:two/model')).toBe('second model notes');
    expect(reloaded.get('openrouter:missing/model')).toBe('');
  });

  it('trims and bounds memory, and clears empty entries', async () => {
    const { memory } = await store();
    memory.set('openrouter:one/model', `  ${'x'.repeat(5_000)}  `);
    expect(memory.get('openrouter:one/model')).toHaveLength(4_000);
    memory.set('openrouter:one/model', '   ');
    expect(memory.get('openrouter:one/model')).toBe('');
  });

  it('clears one model or all models', async () => {
    const { memory } = await store();
    memory.set('openrouter:one/model', 'one');
    memory.set('openrouter:two/model', 'two');
    memory.clear('openrouter:one/model');
    expect(memory.get('openrouter:one/model')).toBe('');
    expect(memory.get('openrouter:two/model')).toBe('two');
    memory.clear();
    expect(memory.get('openrouter:two/model')).toBe('');
  });

  it('treats a corrupt file as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-memory-'));
    const file = join(dir, 'model-memory.json');
    await writeFile(file, '{not json');
    const memory = new ModelMemoryStore(file);
    await memory.ready;
    expect(memory.get('openrouter:one/model')).toBe('');
  });
});
