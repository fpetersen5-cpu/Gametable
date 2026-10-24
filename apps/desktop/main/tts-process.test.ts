import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); mocks.spawn.mockReset(); });

describe('Piper process invocation', () => {
  it('passes an explicit data path, speaker, pace and bounded process timeout', async () => {
    vi.stubEnv('PIPER_ROOT', '/test/piper');
    vi.stubEnv('ESPEAK_DATA_PATH', '/test/data');
    mocks.spawn.mockImplementation((_binary: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; stdin: EventEmitter & { end: (text: string) => void } };
      child.stderr = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), {
        end: () => { void writeFile(args[args.indexOf('--output_file') + 1]!, 'RIFF-test-audio').then(() => child.emit('close', 0)); },
      });
      return child;
    });
    const { synthesize } = await import('./tts.js');
    expect(await synthesize('Hello from the table.', 's1', 318)).toBe(Buffer.from('RIFF-test-audio').toString('base64'));
    expect(mocks.spawn).toHaveBeenCalledWith('/test/piper/piper', expect.arrayContaining([
      '--model', '/test/piper/voices/en_US-libritts_r-medium.onnx',
      '--speaker', '318', '--length_scale', '0.96', '--espeak_data', '/test/data',
    ]), expect.objectContaining({ timeout: 60_000 }));
  });

  it('reports only the bounded tail of native diagnostics', async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; stdin: EventEmitter & { end: (text: string) => void } };
      child.stderr = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), {
        end: () => queueMicrotask(() => { child.stderr.emit('data', Buffer.from('x'.repeat(10000) + 'native-failure')); child.emit('close', 1); }),
      });
      return child;
    });
    const { synthesize } = await import('./tts.js');
    const error = await synthesize('test', 's1').catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toHaveLength(300);
    expect((error as Error).message).toMatch(/native-failure$/);
  });
});
