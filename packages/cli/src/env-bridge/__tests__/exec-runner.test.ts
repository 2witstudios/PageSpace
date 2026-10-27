import { describe, expect, it, vi, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as realSpawn } from 'node:child_process';
import type { NormalizedRequest } from '@pagespace/lib/env-bridge/decide-execution';
import { createExecRunner, type SpawnedChild, type SpawnLike } from '../exec-runner.js';
import type { CommandResolverDeps } from '../command-resolver.js';

const REQUEST: NormalizedRequest = { op: 'exec', cmd: 'tool', args: ['--x'], cwd: '/work', paths: [], env: { CI: '1' }, timeoutMs: 1_000, maxBytes: 16, clamped: false };

const resolver: CommandResolverDeps = {
  platform: 'darwin',
  env: { PATH: '/bin' },
  isExecutableFile: (path) => path === '/usr/local/bin/tool',
  isDirectory: () => false,
  listDir: () => [],
};

function fakeChild(pid = 4242): SpawnedChild & EventEmitter & { stdout: PassThrough; stderr: PassThrough } {
  const child = new EventEmitter() as SpawnedChild & EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function deps(): { spawn: Mock<SpawnLike>; killGroup: Mock<(pid: number, signal: NodeJS.Signals) => void>; resolver: CommandResolverDeps } {
  return { spawn: vi.fn<SpawnLike>(), killGroup: vi.fn<(pid: number, signal: NodeJS.Signals) => void>(), resolver };
}

describe('exec-runner — the ONLY child_process call site; runs a NormalizedRequest and nothing else', () => {
  it('given an allow, should spawn the RESOLVED command with the normalized cwd and ONLY the normalized env plus PATH, detached (own process group)', async () => {
    const d = deps();
    const child = fakeChild();
    d.spawn.mockReturnValue(child);
    const runner = createExecRunner(d);
    const done = runner.run(REQUEST);
    child.stdout.end('hi');
    child.stderr.end('');
    child.emit('close', 0, null);
    const outcome = await done;
    expect(d.spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = d.spawn.mock.calls[0]!;
    expect(command).toBe('/usr/local/bin/tool');
    expect(args).toEqual(['--x']);
    expect(options.cwd).toBe('/work');
    expect(options.detached).toBe(true);
    expect(Object.keys(options.env).sort()).toEqual(['CI', 'PATH']);
    expect(options.env.PATH).toContain('/usr/local/bin');
    expect(outcome).toMatchObject({ exitCode: 0, truncated: false, timedOut: false });
    expect(outcome.stdout.toString()).toBe('hi');
  });

  it('given a request whose env somehow carries a loader hook (LD_PRELOAD), should REFUSE to spawn — defence in depth behind scrubEnv', async () => {
    const d = deps();
    const runner = createExecRunner(d);
    await expect(runner.run({ ...REQUEST, env: { LD_PRELOAD: '/evil.so' } })).rejects.toThrow(/LD_PRELOAD/);
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('given anything but an exec request, should refuse without spawning', async () => {
    const d = deps();
    const runner = createExecRunner(d);
    await expect(runner.run({ ...REQUEST, op: 'fs_read', cmd: undefined })).rejects.toThrow(/exec/);
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('given a command that does not resolve, should answer 127 without spawning', async () => {
    const d = deps();
    const runner = createExecRunner(d);
    const outcome = await runner.run({ ...REQUEST, cmd: 'nope' });
    expect(outcome.exitCode).toBe(127);
    expect(outcome.stderr.toString()).toMatch(/nope/);
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('given output beyond maxBytes, should keep the first maxBytes across both streams and flag truncated', async () => {
    const d = deps();
    const child = fakeChild();
    d.spawn.mockReturnValue(child);
    const done = createExecRunner(d).run(REQUEST);
    child.stdout.write('0123456789');
    child.stderr.write('abcdefghij');
    child.stdout.end('MORE');
    child.stderr.end();
    child.emit('close', 0, null);
    const outcome = await done;
    expect(outcome.truncated).toBe(true);
    expect(outcome.stdout.length + outcome.stderr.length).toBe(16);
  });

  it('given the child outlives timeoutMs, should SIGKILL its PROCESS GROUP and report timedOut', async () => {
    vi.useFakeTimers();
    try {
      const d = deps();
      const child = fakeChild(777);
      d.spawn.mockReturnValue(child);
      const done = createExecRunner(d).run(REQUEST);
      await vi.advanceTimersByTimeAsync(REQUEST.timeoutMs);
      expect(d.killGroup).toHaveBeenCalledWith(777, 'SIGKILL');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null, 'SIGKILL');
      const outcome = await done;
      expect(outcome.timedOut).toBe(true);
      expect(outcome.exitCode).toBe(137);
    } finally {
      vi.useRealTimers();
    }
  });

  it('given a spawn error (EACCES), should resolve 126 with the message rather than reject', async () => {
    const d = deps();
    const child = fakeChild();
    d.spawn.mockReturnValue(child);
    const done = createExecRunner(d).run(REQUEST);
    child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    const outcome = await done;
    expect(outcome.exitCode).toBe(126);
    expect(outcome.stderr.toString()).toMatch(/EACCES/);
  });

  it('killAll (Ctrl-C) should SIGKILL every live process group and leave none tracked', async () => {
    const d = deps();
    const a = fakeChild(1);
    const b = fakeChild(2);
    d.spawn.mockReturnValueOnce(a).mockReturnValueOnce(b);
    const runner = createExecRunner(d);
    const ra = runner.run(REQUEST);
    const rb = runner.run(REQUEST);
    expect(runner.liveCount()).toBe(2);
    runner.killAll();
    expect(d.killGroup).toHaveBeenCalledWith(1, 'SIGKILL');
    expect(d.killGroup).toHaveBeenCalledWith(2, 'SIGKILL');
    for (const child of [a, b]) {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null, 'SIGKILL');
    }
    await Promise.all([ra, rb]);
    expect(runner.liveCount()).toBe(0);
  });

  it('CONTROL (real child_process): given a real allow, should run the command and capture its output', async () => {
    const runner = createExecRunner({ spawn: realSpawn as unknown as SpawnLike, killGroup: (pid, signal) => process.kill(-pid, signal), resolver: { ...resolver, env: process.env, isExecutableFile: (p) => p === '/bin/echo' || p === '/bin/sh' } });
    const outcome = await runner.run({ ...REQUEST, cmd: '/bin/echo', args: ['real'], cwd: process.cwd(), maxBytes: 1024 });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.toString()).toBe('real\n');
  });

  it('CONTROL (real child_process): a timed-out `sh -c "sleep 30"` must not leave the sleep orphaned — the whole group is killed', async () => {
    const runner = createExecRunner({ spawn: realSpawn as unknown as SpawnLike, killGroup: (pid, signal) => process.kill(-pid, signal), resolver: { ...resolver, env: process.env, isExecutableFile: (p) => p === '/bin/sh' } });
    const outcome = await runner.run({ ...REQUEST, cmd: '/bin/sh', args: ['-c', 'echo $$; sleep 30'], cwd: process.cwd(), timeoutMs: 200, maxBytes: 1024 });
    expect(outcome.timedOut).toBe(true);
    const shellPid = Number(outcome.stdout.toString().trim());
    expect(shellPid).toBeGreaterThan(0);
    // The shell's group is gone: signalling it fails with ESRCH.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(-shellPid, 0)).toThrow(/ESRCH/);
  });
});
