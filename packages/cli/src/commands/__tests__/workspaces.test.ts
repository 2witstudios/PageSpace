import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  extractExecArgs,
  parseArgv,
  quoteShellArgs,
  remoteExitCode,
  renderWorkspacesList,
  workspacesExecHandler,
  workspacesListHandler,
} from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const WORKSPACE = {
  workspaceId: 'ws_1',
  driveId: 'drive_1',
  ownerId: 'user_1',
  name: 'worker',
  envId: null,
  sandboxStatus: 'running',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: null,
  endedAt: null,
};

describe('extractExecArgs', () => {
  it('takes everything after -- as the command, flags before it', () => {
    expect(extractExecArgs(['ws_1', '--cwd', 'repo', '--timeout-ms', '5000', '--', 'ls', '-la', '--json'])).toEqual({
      ok: true,
      workspaceId: 'ws_1',
      command: 'ls -la --json',
      cwd: 'repo',
      timeoutMs: 5000,
    });
  });

  it('accepts one quoted command argument without --', () => {
    expect(extractExecArgs(['ws_1', 'ls -la | wc -l'])).toEqual({ ok: true, workspaceId: 'ws_1', command: 'ls -la | wc -l' });
  });

  it('refuses several bare command words without --, so a local shell split is never guessed at', () => {
    expect(extractExecArgs(['ws_1', 'ls', '-la']).ok).toBe(false);
  });

  it('refuses a missing workspace, a missing command, and a bad timeout', () => {
    expect(extractExecArgs([]).ok).toBe(false);
    expect(extractExecArgs(['ws_1', '--']).ok).toBe(false);
    expect(extractExecArgs(['ws_1', '--timeout-ms', 'soon', '--', 'ls']).ok).toBe(false);
    expect(extractExecArgs(['ws_1', '--bogus', '--', 'ls']).ok).toBe(false);
  });
});

describe('quoteShellArgs', () => {
  it('leaves safe words unquoted', () => {
    expect(quoteShellArgs(['ls', '-la', '--json', 'a/b.c', 'k=v:x@y%z+w,q'])).toBe('ls -la --json a/b.c k=v:x@y%z+w,q');
  });

  it('single-quotes a word with spaces, ;, or $', () => {
    expect(quoteShellArgs(['sh', '-c', 'echo hi; exit 3'])).toBe("sh -c 'echo hi; exit 3'");
    expect(quoteShellArgs(['echo', '$HOME'])).toBe("echo '$HOME'");
    expect(quoteShellArgs(['echo', 'a b'])).toBe("echo 'a b'");
  });

  it("escapes an embedded single quote as '\\'' and quotes an empty word as ''", () => {
    expect(quoteShellArgs(['echo', "it's"])).toBe("echo 'it'\\''s'");
    expect(quoteShellArgs(['printf', ''])).toBe("printf ''");
  });
});

describe('extractExecArgs argument boundaries', () => {
  it('preserves each word after -- as a separate shell word', () => {
    expect(extractExecArgs(['ws_1', '--', 'sh', '-c', 'echo hi; exit 3'])).toEqual({
      ok: true,
      workspaceId: 'ws_1',
      command: "sh -c 'echo hi; exit 3'",
    });
    expect(extractExecArgs(['ws_1', '--', 'echo', "it's $HOME", ''])).toEqual({
      ok: true,
      workspaceId: 'ws_1',
      command: "echo 'it'\\''s $HOME' ''",
    });
  });

  it('sends exactly one argument after -- verbatim as a command line', () => {
    expect(extractExecArgs(['ws_1', '--', 'ls | wc -l; echo $HOME'])).toEqual({
      ok: true,
      workspaceId: 'ws_1',
      command: 'ls | wc -l; echo $HOME',
    });
  });
});

describe('remoteExitCode', () => {
  it('passes 0..255 through and maps anything else to a runtime error', () => {
    expect(remoteExitCode(0)).toBe(0);
    expect(remoteExitCode(3)).toBe(3);
    expect(remoteExitCode(255)).toBe(255);
    expect(remoteExitCode(-1)).toBe(EXIT_RUNTIME_ERROR);
    expect(remoteExitCode(1.5)).toBe(EXIT_RUNTIME_ERROR);
  });
});

describe('pagespace workspaces exec', () => {
  it('runs the command, streams stdout/stderr to the matching sinks, and exits with the remote status', async () => {
    const exec = vi.fn(async () => ({ stdout: 'hi\n', stderr: 'warn\n', exitCode: 3, truncated: false }));
    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ workspaces: { exec } }), stdout, stderr });

    const code = await workspacesExecHandler(ctx, commandIntent(['ws_1', '--', 'sh', '-c', 'echo hi; exit 3']));

    expect(code).toBe(3);
    expect(exec).toHaveBeenCalledWith({ workspaceId: 'ws_1', command: "sh -c 'echo hi; exit 3'", cwd: undefined, timeoutMs: undefined });
    expect(stdout.lines).toEqual(['hi\n']);
    expect(stderr.lines).toEqual(['warn\n']);
  });

  it('notes truncation on stderr', async () => {
    const exec = vi.fn(async () => ({ stdout: 'x', stderr: '', exitCode: 0, truncated: true }));
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ workspaces: { exec } }), stderr });
    expect(await workspacesExecHandler(ctx, commandIntent(['ws_1', 'yes | head']))).toBe(EXIT_SUCCESS);
    expect(stderr.lines.join('')).toContain('truncated');
  });

  it('with --json, prints the raw result and still exits with the remote status', async () => {
    const result = { stdout: 'hi\n', stderr: '', exitCode: 1, truncated: false };
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ workspaces: { exec: async () => result } }), stdout });
    expect(await workspacesExecHandler(ctx, commandIntent(['ws_1', '--json', '--', 'false']))).toBe(1);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(result);
  });

  it('surfaces a refusal as a runtime error with the server message', async () => {
    const stderr = createRecordingSink();
    const exec = async () => {
      throw new Error('Running code requires a Pro plan or above.');
    };
    const ctx = createFakeContext({ sdk: fakeSdk({ workspaces: { exec } }), stderr });
    expect(await workspacesExecHandler(ctx, commandIntent(['ws_1', '--', 'ls']))).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Pro plan');
  });

  it('refuses bad usage without calling the SDK', async () => {
    const exec = vi.fn();
    const ctx = createFakeContext({ sdk: fakeSdk({ workspaces: { exec } }) });
    expect(await workspacesExecHandler(ctx, commandIntent(['ws_1']))).toBe(EXIT_USAGE_ERROR);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('pagespace workspaces list', () => {
  it('renders one line per workspace', async () => {
    const list = vi.fn(async () => ({ sessions: [WORKSPACE, { ...WORKSPACE, workspaceId: 'ws_2', driveId: null, endedAt: '2026-01-02T00:00:00.000Z' }] }));
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ workspaces: { list } }), stdout });
    expect(await workspacesListHandler(ctx, commandIntent([]))).toBe(EXIT_SUCCESS);
    expect(list).toHaveBeenCalledWith({});
    expect(stdout.lines.join('')).toBe(
      'ws_1  worker  [running]  drive: drive_1\nws_2  worker  [running]  drive: (none)  (ended)\n',
    );
  });

  it('narrows by --drive', async () => {
    const list = vi.fn(async () => ({ sessions: [] }));
    const ctx = createFakeContext({ sdk: fakeSdk({ workspaces: { list } }) });
    await workspacesListHandler(ctx, commandIntent(['--drive', 'drive_1']));
    expect(list).toHaveBeenCalledWith({ driveId: 'drive_1' });
  });

  it('refuses an unknown argument', async () => {
    const ctx = createFakeContext({ sdk: fakeSdk({ workspaces: { list: vi.fn() } }) });
    expect(await workspacesListHandler(ctx, commandIntent(['extra']))).toBe(EXIT_USAGE_ERROR);
  });

  it('renders an empty list plainly', () => {
    expect(renderWorkspacesList({ sessions: [] })).toBe('No workspaces.\n');
  });
});
