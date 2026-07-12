import { describe, it, expect } from 'vitest';
import { listMachineDirectory, readMachineFile } from '../machine-fs';
import type { MachineHandle } from '../machine-host';
import type { RunCommandArgs, SandboxRunResult } from '../sandbox-client/types';

/**
 * The primitives take a `MachineHandle` as an injected dependency, so a fake
 * one — exec/readFile programmable, the PTY surface stubbed — exercises every
 * branch with zero real Sprite calls.
 */
function makeHandle(overrides: {
  exec?: (args: RunCommandArgs) => Promise<SandboxRunResult>;
  readFile?: (args: { path: string }) => Promise<Buffer | null>;
}): MachineHandle {
  return {
    machineId: 'sbx-test',
    exec: overrides.exec ?? (async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    readFile: overrides.readFile ?? (async () => null),
    writeFiles: async () => {},
    createCheckpoint: async () => {},
    stream: async () => {
      throw new Error('stream() is not used by the fs primitives');
    },
    listStreams: async () => [],
  };
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
