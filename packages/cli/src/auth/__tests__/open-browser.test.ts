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

  it('on win32, refuses to hand cmd.exe a URL containing cmd metacharacters (untrusted discovery-doc URL) — falls back instead of risking truncation/injection', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const { openBrowser } = await import('@pagespace/cli');
      const maliciousUrl = 'https://pagespace.ai/api/oauth/authorize?client_id=x&state=y&extra=z ^& calc.exe';

      const opened = await openBrowser(maliciousUrl);

      expect(opened).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('on win32, still opens a plain URL with no cmd metacharacters, passing it through verbatim (untruncated)', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const { openBrowser } = await import('@pagespace/cli');
      const url = 'https://pagespace.ai/api/oauth/authorize?client_id=x';

      const opened = openBrowser(url);
      child.emit('spawn');

      await expect(opened).resolves.toBe(true);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(command).toBe('cmd');
      expect(args.join(' ')).toContain(url);
    } finally {
      platformSpy.mockRestore();
    }
  });
});
