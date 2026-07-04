import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    spawnMock.mockReset();
  });

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

  it('on win32, opens a real authorize URL (multiple &-joined query params, always present per loopback-flow.ts) without truncation, via rundll32 rather than cmd.exe', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const { openBrowser } = await import('@pagespace/cli');
      const url =
        'https://pagespace.ai/api/oauth/authorize?response_type=code&client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback&code_challenge=abc&code_challenge_method=S256&scope=account+offline_access&state=y';

      const opened = openBrowser(url);
      child.emit('spawn');

      await expect(opened).resolves.toBe(true);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
      // Never cmd.exe: its lexer would split on the `&`s a real authorize URL
      // always contains, which is exactly the bug being fixed here.
      expect(command).not.toBe('cmd');
      expect(command).toBe('rundll32');
      expect(args).toContain(url);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('on win32, a URL containing cmd metacharacters (e.g. a hostile discovery doc) is still passed through intact, not mangled or truncated, since rundll32 never invokes a shell', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const { openBrowser } = await import('@pagespace/cli');
      const hostileUrl = 'https://pagespace.ai/api/oauth/authorize?client_id=x&state=y ^& calc.exe';

      const opened = openBrowser(hostileUrl);
      child.emit('spawn');

      await expect(opened).resolves.toBe(true);
      const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(command).toBe('rundll32');
      expect(args).toContain(hostileUrl);
    } finally {
      platformSpy.mockRestore();
    }
  });
});
