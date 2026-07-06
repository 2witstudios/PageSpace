import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { openPtyShell } from '../sprites-shell';
import type {
  SpriteInstanceLike,
  SpriteCommandLike,
  SpriteSessionInfo,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';

type FakeCommand = SpriteCommandLike & { _stdout: EventEmitter; _stderr: EventEmitter; _emitter: EventEmitter };

function buildFakeCommand(): FakeCommand {
  const _stdout = new EventEmitter();
  const _stderr = new EventEmitter();
  const _emitter = new EventEmitter();
  const stdinWrite = vi.fn();
  const resizeFn = vi.fn();
  const killFn = vi.fn();

  const cmd: FakeCommand = {
    _stdout,
    _stderr,
    _emitter,
    stdout: { on: (event, listener) => { _stdout.on(event, listener); return _stdout; } },
    stderr: { on: (event, listener) => { _stderr.on(event, listener); return _stderr; } },
    stdin: { write: stdinWrite },
    resize: resizeFn,
    kill: killFn,
    on: (event: string, listener: (...args: unknown[]) => void) => { _emitter.on(event, listener); return _emitter; },
  };
  return cmd;
}

type FakeSprite = SpriteInstanceLike & {
  createSession: ReturnType<typeof vi.fn>;
  attachSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
};

function buildFakeSprite(
  cmd: SpriteCommandLike,
  opts: { sessions?: SpriteSessionInfo[]; attachCmd?: SpriteCommandLike; listRejects?: boolean } = {},
): FakeSprite {
  return {
    name: 'fake-sprite',
    spawn: vi.fn(),
    createSession: vi.fn(() => cmd),
    attachSession: vi.fn(() => opts.attachCmd ?? cmd),
    listSessions: vi.fn(async () => {
      if (opts.listRejects) throw new Error('list failed');
      return opts.sessions ?? [];
    }),
    filesystem: vi.fn(),
    updateNetworkPolicy: vi.fn(),
    destroy: vi.fn(),
  } as unknown as FakeSprite;
}

const liveSession: SpriteSessionInfo = { id: 'sess-1', command: 'bash', isActive: true, tty: true };

describe('openPtyShell', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('given a sprite and dimensions, should create a detachable session with bash + tty + dims + cwd + terminal env', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });

    expect(sprite.createSession).toHaveBeenCalledWith('bash', [], {
      tty: true,
      cols: 80,
      rows: 24,
      cwd: '/workspace',
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' },
    });
  });

  it('given a command/args (pluggable agent terminal), should create a session launching that command instead of bash', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);

    openPtyShell({ sprite, cols: 80, rows: 24, command: 'claude', args: ['--dangerously-skip-permissions'], onOutput: vi.fn(), onExit: vi.fn() });

    expect(sprite.createSession).toHaveBeenCalledWith('claude', ['--dangerously-skip-permissions'], {
      tty: true,
      cols: 80,
      rows: 24,
      cwd: '/workspace',
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' },
    });
  });

  it('given a custom cwd, should create the session there instead of the default sandbox root', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);

    openPtyShell({ sprite, cols: 80, rows: 24, command: 'pagespace-cli', cwd: '/workspace/repo', onOutput: vi.fn(), onExit: vi.fn() });

    expect(sprite.createSession).toHaveBeenCalledWith('pagespace-cli', [], expect.objectContaining({ cwd: '/workspace/repo' }));
  });

  it('given a sessionId, should attach to the existing session instead of creating one', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);

    openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-1', onOutput: vi.fn(), onExit: vi.fn() });

    expect(sprite.attachSession).toHaveBeenCalledWith('sess-1', { cols: 80, rows: 24 });
    expect(sprite.createSession).not.toHaveBeenCalled();
  });

  it('given sprite emits stdout data, should call onOutput with the string', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);
    const onOutput = vi.fn();

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
    cmd._stdout.emit('data', 'hello\r\n');

    expect(onOutput).toHaveBeenCalledWith('hello\r\n');
  });

  it('given sprite emits stderr data, should call onOutput with the string', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);
    const onOutput = vi.fn();

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
    cmd._stderr.emit('data', Buffer.from('err msg'));

    expect(onOutput).toHaveBeenCalledWith('err msg');
  });

  it('given sprite emits exit, should call onExit with the exit code', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);
    const onExit = vi.fn();

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit });
    cmd._emitter.emit('exit', 0);

    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('given shell.write(data), should call stdin.write with that data', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);

    const shell = openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
    shell.write('ls\n');

    expect(cmd.stdin!.write).toHaveBeenCalledWith('ls\n');
  });

  it('given shell.resize(100, 40), should call command.resize with those dimensions', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);

    const shell = openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
    shell.resize(100, 40);

    expect(cmd.resize).toHaveBeenCalledWith(100, 40);
  });

  it('given shell.kill(), should call command.kill with SIGKILL', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);

    const shell = openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
    shell.kill();

    expect(cmd.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('given stdin is null, shell.write should be a no-op', () => {
    const cmd = buildFakeCommand();
    (cmd as Record<string, unknown>).stdin = null;
    const sprite = buildFakeSprite(cmd);

    const shell = openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
    expect(() => shell.write('ls\n')).not.toThrow();
  });

  it('given exit emits null code, should call onExit with -1', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);
    const onExit = vi.fn();

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit });
    cmd._emitter.emit('exit', null);

    expect(onExit).toHaveBeenCalledWith(-1);
  });

  describe('reconnect on transient WebSocket drop', () => {
    it('given an error and a live session exists, should reattach and NOT call onExit', async () => {
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit });
      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);

      expect(sprite.attachSession).toHaveBeenCalledWith('sess-1', { cols: 80, rows: 24 });
      expect(onExit).not.toHaveBeenCalled();
    });

    it('given a reattached session, output flows from the new command', async () => {
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);

      attachCmd._stdout.emit('data', 'back\r\n');
      expect(onOutput).toHaveBeenCalledWith('back\r\n');
    });

    it('given an error and NO live session, should call onExit(-1) without an error banner', async () => {
      const cmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [] });
      const onOutput = vi.fn();
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });
      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);

      expect(onExit).toHaveBeenCalledWith(-1);
      expect(onOutput).not.toHaveBeenCalledWith(expect.stringContaining('Shell error'));
    });

    it('given reattach repeatedly fails, should give up after the bounded budget and surface onExit(-1)', async () => {
      const cmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { listRejects: true });
      const onOutput = vi.fn();
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });
      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(10_000);

      expect(onExit).toHaveBeenCalledWith(-1);
      expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('lost connection'));
    });

    it('given a genuine exit (not an error), should call onExit immediately without reattaching', () => {
      const cmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit });
      cmd._emitter.emit('exit', 0);

      expect(onExit).toHaveBeenCalledWith(0);
      expect(sprite.attachSession).not.toHaveBeenCalled();
    });

    it('given a command that errored, should IGNORE its trailing stale exit and reattach instead', async () => {
      // A keepalive timeout in the SDK emits 'error' AND THEN closes the socket,
      // which makes the same dead transport emit a spurious 'exit' (code 0). That
      // stale exit must not tear the session down while reconnect() is in flight.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit });
      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      cmd._emitter.emit('exit', 0); // trailing stale exit from the SAME dead command
      await vi.advanceTimersByTimeAsync(500);

      expect(onExit).not.toHaveBeenCalled();
      expect(sprite.attachSession).toHaveBeenCalledWith('sess-1', { cols: 80, rows: 24 });
    });

    it('given repeated idle keepalive cycles that each reattach successfully, should NOT trip the bounded budget', async () => {
      // Each cycle: the live command errors (keepalive drop) → reconnect →
      // attachSession returns a fresh command that confirms open via 'spawn' but
      // emits NO stdout. The 'spawn' reset must keep the budget from climbing, so
      // a healthy-but-quiet shell survives indefinitely. Without it, the failure
      // counter would reach the fatal budget (> 5) and close the terminal.
      const initial = buildFakeCommand();
      const attached: FakeCommand[] = [];
      const sprite = buildFakeSprite(initial, { sessions: [liveSession] });
      // A successful reattach: fresh command, emits 'spawn' once wired (next tick).
      sprite.attachSession.mockImplementation(() => {
        const next = buildFakeCommand();
        attached.push(next);
        setTimeout(() => next._emitter.emit('spawn'), 0);
        return next;
      });
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit });

      // Run more cycles than MAX_RECONNECT_ATTEMPTS (5) would otherwise allow.
      let currentCmd: FakeCommand = initial;
      for (let i = 0; i < 8; i += 1) {
        currentCmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
        await vi.advanceTimersByTimeAsync(2000); // cover backoff delay + spawn tick
        currentCmd = attached[attached.length - 1];
      }

      expect(onExit).not.toHaveBeenCalled();
      expect(sprite.attachSession.mock.calls.length).toBeGreaterThan(5);
    });

    it('given the shell was killed, a trailing exit does not double-fire onExit', () => {
      // kill() sets closed=true; a subsequent exit hits the `closed` guard in fatal().
      const cmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd);
      const onExit = vi.fn();

      const shell = openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit });
      shell.kill();
      cmd._emitter.emit('exit', 0);

      expect(onExit).not.toHaveBeenCalled();
    });

    it('given a second error while a reconnect is already in flight, ignores the duplicate', async () => {
      // The second error hits the `reconnecting` guard in reconnect() — only one reattach.
      const cmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd: buildFakeCommand() });

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
      cmd._emitter.emit('error', new Error('keepalive'));
      cmd._emitter.emit('error', new Error('keepalive again'));
      await vi.advanceTimersByTimeAsync(500);

      expect(sprite.attachSession).toHaveBeenCalledTimes(1);
    });

    it('given the shell is killed during the reconnect backoff, aborts the pending reattach', async () => {
      // kill() sets closed=true mid-delay; reconnect resumes, sees `closed`, and bails before attaching.
      const cmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd: buildFakeCommand() });

      const shell = openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
      cmd._emitter.emit('error', new Error('keepalive'));
      shell.kill();
      await vi.advanceTimersByTimeAsync(500);

      expect(sprite.attachSession).not.toHaveBeenCalled();
    });

    it('given the session id is unknown at reconnect, resolves the live session via listSessions and attaches', async () => {
      // Background id-capture returns [] (id stays undefined); reconnect's own
      // listSessions returns the live session → the pickShellSession()?.id branch.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd);
      sprite.listSessions
        .mockResolvedValueOnce([])             // create-path background capture
        .mockResolvedValueOnce([liveSession]); // reconnect resolution
      sprite.attachSession.mockImplementation(() => attachCmd);
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit });
      await vi.advanceTimersByTimeAsync(0); // flush background listSessions ([])
      cmd._emitter.emit('error', new Error('keepalive'));
      await vi.advanceTimersByTimeAsync(500);

      expect(sprite.attachSession).toHaveBeenCalledWith('sess-1', { cols: 80, rows: 24 });
      expect(onExit).not.toHaveBeenCalled();
    });
  });
});
