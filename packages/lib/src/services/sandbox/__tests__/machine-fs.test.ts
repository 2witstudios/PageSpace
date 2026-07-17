import { describe, it, expect } from 'vitest';
import {
  listMachineDirectory,
  readMachineFile,
  createMachineDirectory,
  writeMachineFile,
  moveMachinePath,
  copyMachinePath,
  deleteMachinePath,
} from '../machine-fs';
import type { MachineHandle } from '../machine-host';
import type { RunCommandArgs, SandboxRunResult } from '../sandbox-client/types';
import type { WriteFileEntry } from '../sandbox-client/types';

/**
 * The primitives take a `MachineHandle` as an injected dependency, so a fake
 * one — exec/readFile programmable, the PTY surface stubbed — exercises every
 * branch with zero real Sprite calls.
 */
function makeHandle(overrides: {
  exec?: (args: RunCommandArgs) => Promise<SandboxRunResult>;
  readFile?: (args: { path: string }) => Promise<Buffer | null>;
  writeFiles?: (files: WriteFileEntry[]) => Promise<void>;
}): MachineHandle {
  return {
    machineId: 'sbx-test',
    spriteInstanceId: null,
    exec: overrides.exec ?? (async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    readFile: overrides.readFile ?? (async () => null),
    writeFiles: overrides.writeFiles ?? (async () => {}),
    createCheckpoint: async () => {},
    stream: async () => {
      throw new Error('stream() is not used by the fs primitives');
    },
    listStreams: async () => [],
    killSession: async () => {},
  };
}

/** Records every `exec` call's argv for assertions on argv shape/ordering. */
function makeExecRecorder(
  responder: (args: RunCommandArgs) => SandboxRunResult,
): { handle: MachineHandle; calls: RunCommandArgs[] } {
  const calls: RunCommandArgs[] = [];
  const handle = makeHandle({
    exec: async (args) => {
      calls.push(args);
      return responder(args);
    },
  });
  return { handle, calls };
}

describe('listMachineDirectory', () => {
  it('parses `ls -Ap` output into files and directories, stripping the dir slash', async () => {
    const handle = makeHandle({
      exec: async () => ({
        exitCode: 0,
        stdout: 'Dockerfile\nsrc/\n.gitignore\nnode_modules/\nREADME.md\n',
        stderr: '',
      }),
    });

    const result = await listMachineDirectory({ handle, path: '/workspace/repo' });

    expect(result).toEqual({
      ok: true,
      entries: [
        { name: 'Dockerfile', type: 'file' },
        { name: 'src', type: 'directory' },
        { name: '.gitignore', type: 'file' },
        { name: 'node_modules', type: 'directory' },
        { name: 'README.md', type: 'file' },
      ],
    });
  });

  it('invokes `ls -Ap -- <path>` so a leading-dash path is never read as a flag', async () => {
    let seen: RunCommandArgs | undefined;
    const handle = makeHandle({
      exec: async (args) => {
        seen = args;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    await listMachineDirectory({ handle, path: '-weird-dir' });

    expect(seen).toEqual({ cmd: 'ls', args: ['-Ap', '--', '-weird-dir'] });
  });

  it('returns an empty list for an empty directory', async () => {
    const handle = makeHandle({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
    const result = await listMachineDirectory({ handle, path: '/workspace/repo/empty' });
    expect(result).toEqual({ ok: true, entries: [] });
  });

  it('maps a missing path (nonzero exit + "No such file") to not_found', async () => {
    const handle = makeHandle({
      exec: async () => ({
        exitCode: 2,
        stdout: '',
        stderr: "ls: cannot access '/nope': No such file or directory\n",
      }),
    });
    const result = await listMachineDirectory({ handle, path: '/nope' });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'not_found' });
  });

  it('maps any other nonzero exit to exec_failed and surfaces stderr detail', async () => {
    const handle = makeHandle({
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'ls: permission denied\n' }),
    });
    const result = await listMachineDirectory({ handle, path: '/root/private' });
    expect(result).toEqual({ ok: false, reason: 'exec_failed', detail: 'ls: permission denied' });
  });
});

describe('readMachineFile', () => {
  it('returns the file bytes from the handle', async () => {
    const bytes = Buffer.from('hello world', 'utf8');
    const handle = makeHandle({ readFile: async () => bytes });

    const result = await readMachineFile({ handle, path: '/workspace/repo/README.md' });

    expect(result).toEqual({ ok: true, content: bytes });
  });

  it('passes the requested path straight through to the handle', async () => {
    let seen: { path: string } | undefined;
    const handle = makeHandle({
      readFile: async (args) => {
        seen = args;
        return Buffer.from('', 'utf8');
      },
    });

    await readMachineFile({ handle, path: '/workspace/repo/src/index.ts' });

    expect(seen).toEqual({ path: '/workspace/repo/src/index.ts' });
  });

  it('maps a missing file (handle returns null) to not_found', async () => {
    const handle = makeHandle({ readFile: async () => null });
    const result = await readMachineFile({ handle, path: '/workspace/repo/missing' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('createMachineDirectory', () => {
  it('invokes `mkdir -- <path>` and reports success on exit 0', async () => {
    const { handle, calls } = makeExecRecorder(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result = await createMachineDirectory({ handle, path: '/workspace/repo/new-dir' });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ cmd: 'mkdir', args: ['--', '/workspace/repo/new-dir'] }]);
  });

  it('a leading-dash path is passed after `--`, never read as a flag', async () => {
    const { handle, calls } = makeExecRecorder(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    await createMachineDirectory({ handle, path: '-weird-dir' });

    expect(calls).toEqual([{ cmd: 'mkdir', args: ['--', '-weird-dir'] }]);
  });

  it('maps "File exists" stderr to already_exists', async () => {
    const handle = makeHandle({
      exec: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: "mkdir: cannot create directory '/workspace/repo/x': File exists\n",
      }),
    });
    const result = await createMachineDirectory({ handle, path: '/workspace/repo/x' });
    expect(result).toEqual({ ok: false, reason: 'already_exists' });
  });

  it('maps a missing parent ("No such file or directory") to not_found', async () => {
    const handle = makeHandle({
      exec: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: "mkdir: cannot create directory '/workspace/missing/x': No such file or directory\n",
      }),
    });
    const result = await createMachineDirectory({ handle, path: '/workspace/missing/x' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('maps any other nonzero exit to exec_failed with trimmed stderr detail', async () => {
    const handle = makeHandle({
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'mkdir: permission denied\n' }),
    });
    const result = await createMachineDirectory({ handle, path: '/root/x' });
    expect(result).toEqual({ ok: false, reason: 'exec_failed', detail: 'mkdir: permission denied' });
  });
});

describe('writeMachineFile', () => {
  it('calls handle.writeFiles with the path and content, and reports success', async () => {
    let seen: WriteFileEntry[] | undefined;
    const handle = makeHandle({
      writeFiles: async (files) => {
        seen = files;
      },
    });

    const result = await writeMachineFile({
      handle,
      path: '/workspace/repo/README.md',
      content: 'hello',
    });

    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ path: '/workspace/repo/README.md', content: 'hello' }]);
  });

  it('accepts Uint8Array content and passes it through unchanged', async () => {
    let seen: WriteFileEntry[] | undefined;
    const bytes = new Uint8Array([1, 2, 3]);
    const handle = makeHandle({
      writeFiles: async (files) => {
        seen = files;
      },
    });

    await writeMachineFile({ handle, path: '/workspace/repo/bin.dat', content: bytes });

    expect(seen).toEqual([{ path: '/workspace/repo/bin.dat', content: bytes }]);
  });

  it('folds a driver throw into exec_failed with the error message as detail', async () => {
    const handle = makeHandle({
      writeFiles: async () => {
        throw new Error('disk full');
      },
    });

    const result = await writeMachineFile({ handle, path: '/workspace/repo/x', content: 'y' });

    expect(result).toEqual({ ok: false, reason: 'exec_failed', detail: 'disk full' });
  });
});

describe('moveMachinePath', () => {
  it('runs the `test -e -o -L` guard then `mv -T -- <from> <to>` when the destination is free', async () => {
    const { handle, calls } = makeExecRecorder((args) => {
      if (args.cmd === 'test') return { exitCode: 1, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await moveMachinePath({
      handle,
      fromPath: '/workspace/repo/a.txt',
      toPath: '/workspace/repo/b.txt',
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      { cmd: 'test', args: ['-e', '/workspace/repo/b.txt', '-o', '-L', '/workspace/repo/b.txt'] },
      { cmd: 'mv', args: ['-T', '--', '/workspace/repo/a.txt', '/workspace/repo/b.txt'] },
    ]);
  });

  it('returns already_exists without calling mv when the guard finds the destination present', async () => {
    const { handle, calls } = makeExecRecorder(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result = await moveMachinePath({
      handle,
      fromPath: '/workspace/repo/a.txt',
      toPath: '/workspace/repo/existing.txt',
    });

    expect(result).toEqual({ ok: false, reason: 'already_exists' });
    expect(calls).toEqual([
      { cmd: 'test', args: ['-e', '/workspace/repo/existing.txt', '-o', '-L', '/workspace/repo/existing.txt'] },
    ]);
    expect(calls.some((c) => c.cmd === 'mv')).toBe(false);
  });

  it('returns already_exists (not a clobber) when the destination is a dangling symlink', async () => {
    // `test -e` alone follows symlinks and would report `false` for a symlink
    // whose target is missing; only `-L` also matches it. Simulate a driver
    // that faithfully implements that distinction: `-e` fails, `-e -o -L` (as
    // this guard sends it) succeeds.
    const { handle, calls } = makeExecRecorder((args) => {
      if (args.cmd === 'test') {
        const isDanglingSymlinkAware = args.args?.includes('-L');
        return { exitCode: isDanglingSymlinkAware ? 0 : 1, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await moveMachinePath({
      handle,
      fromPath: '/workspace/repo/a.txt',
      toPath: '/workspace/repo/dangling-link',
    });

    expect(result).toEqual({ ok: false, reason: 'already_exists' });
    expect(calls.some((c) => c.cmd === 'mv')).toBe(false);
  });

  it('maps a missing source to not_found', async () => {
    const { handle } = makeExecRecorder((args) => {
      if (args.cmd === 'test') return { exitCode: 1, stdout: '', stderr: '' };
      return {
        exitCode: 1,
        stdout: '',
        stderr: "mv: cannot stat '/workspace/repo/gone.txt': No such file or directory\n",
      };
    });

    const result = await moveMachinePath({
      handle,
      fromPath: '/workspace/repo/gone.txt',
      toPath: '/workspace/repo/b.txt',
    });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('maps any other mv failure to exec_failed', async () => {
    const { handle } = makeExecRecorder((args) => {
      if (args.cmd === 'test') return { exitCode: 1, stdout: '', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'mv: permission denied\n' };
    });

    const result = await moveMachinePath({
      handle,
      fromPath: '/workspace/repo/a.txt',
      toPath: '/workspace/repo/b.txt',
    });

    expect(result).toEqual({ ok: false, reason: 'exec_failed', detail: 'mv: permission denied' });
  });
});

describe('copyMachinePath', () => {
  it('runs the `test -e -o -L` guard then `cp -a -- <from> <to>` when the destination is free', async () => {
    const { handle, calls } = makeExecRecorder((args) => {
      if (args.cmd === 'test') return { exitCode: 1, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await copyMachinePath({
      handle,
      fromPath: '/workspace/repo/a.txt',
      toPath: '/workspace/repo/b.txt',
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      { cmd: 'test', args: ['-e', '/workspace/repo/b.txt', '-o', '-L', '/workspace/repo/b.txt'] },
      { cmd: 'cp', args: ['-a', '--', '/workspace/repo/a.txt', '/workspace/repo/b.txt'] },
    ]);
  });

  it('returns already_exists without calling cp when the guard finds the destination present', async () => {
    const { handle, calls } = makeExecRecorder(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result = await copyMachinePath({
      handle,
      fromPath: '/workspace/repo/a.txt',
      toPath: '/workspace/repo/existing.txt',
    });

    expect(result).toEqual({ ok: false, reason: 'already_exists' });
    expect(calls).toEqual([
      { cmd: 'test', args: ['-e', '/workspace/repo/existing.txt', '-o', '-L', '/workspace/repo/existing.txt'] },
    ]);
    expect(calls.some((c) => c.cmd === 'cp')).toBe(false);
  });

  it('returns already_exists (not a clobber) when the destination is a dangling symlink', async () => {
    const { handle, calls } = makeExecRecorder((args) => {
      if (args.cmd === 'test') {
        const isDanglingSymlinkAware = args.args?.includes('-L');
        return { exitCode: isDanglingSymlinkAware ? 0 : 1, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await copyMachinePath({
      handle,
      fromPath: '/workspace/repo/a.txt',
      toPath: '/workspace/repo/dangling-link',
    });

    expect(result).toEqual({ ok: false, reason: 'already_exists' });
    expect(calls.some((c) => c.cmd === 'cp')).toBe(false);
  });

  it('maps a missing source to not_found', async () => {
    const { handle } = makeExecRecorder((args) => {
      if (args.cmd === 'test') return { exitCode: 1, stdout: '', stderr: '' };
      return {
        exitCode: 1,
        stdout: '',
        stderr: "cp: cannot stat '/workspace/repo/gone.txt': No such file or directory\n",
      };
    });

    const result = await copyMachinePath({
      handle,
      fromPath: '/workspace/repo/gone.txt',
      toPath: '/workspace/repo/b.txt',
    });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('deleteMachinePath', () => {
  it('invokes `rm -rf -- <path>` and reports success', async () => {
    const { handle, calls } = makeExecRecorder(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result = await deleteMachinePath({ handle, path: '/workspace/repo/tmp' });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ cmd: 'rm', args: ['-rf', '--', '/workspace/repo/tmp'] }]);
  });

  it('is idempotent: deleting an already-missing path still reports ok: true', async () => {
    const handle = makeHandle({
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    const result = await deleteMachinePath({ handle, path: '/workspace/repo/already-gone' });

    expect(result).toEqual({ ok: true });
    expect(result.ok).toBe(true);
  });

  it('maps a nonzero exit to exec_failed with stderr detail', async () => {
    const handle = makeHandle({
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'rm: permission denied\n' }),
    });

    const result = await deleteMachinePath({ handle, path: '/root/protected' });

    expect(result).toEqual({ ok: false, reason: 'exec_failed', detail: 'rm: permission denied' });
  });
});
