import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function fakeChild(): EventEmitter & { unref(): void } {
  const child = new EventEmitter() as EventEmitter & { unref(): void };
  child.unref = () => {};
  return child;
}

describe('openBrowser', () => {
  it('resolves true once the child process reports a successful spawn', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { openBrowser } = await import('@pagespace/cli');

    const opened = openBrowser('https://pagespace.ai/api/oauth/authorize?x=1');
    child.emit('spawn');

    await expect(opened).resolves.toBe(true);
  });

  it('resolves false when the child process errors (e.g. missing binary)', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { openBrowser } = await import('@pagespace/cli');

    const opened = openBrowser('https://pagespace.ai/api/oauth/authorize?x=1');
    child.emit('error', new Error('ENOENT'));

    await expect(opened).resolves.toBe(false);
  });

  it('resolves false, never throws, if spawn itself throws synchronously', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    const { openBrowser } = await import('@pagespace/cli');

    await expect(openBrowser('https://pagespace.ai')).resolves.toBe(false);
  });
});
