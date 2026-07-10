import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { openPtyShell, planReconnect, liveShellSessionIds, newTtySessionId } from '../sprites-shell';

// riteway-style assertion (given/should/actual/expected) on top of vitest — the
// repo doesn't vendor riteway and bun-only rules forbid adding a dependency for
// a handful of pure-function cases, so keep the contract, drop the package.
function assert<T>({ given, should, actual, expected }: { given: string; should: string; actual: T; expected: T }): void {
  it(`given ${given}, should ${should}`, () => {
    expect(actual).toEqual(expected);
  });
}

// A promise whose resolution the test drives, to interleave a fire-and-forget
// listSessions() against fake-timer-driven reconnect steps.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
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

describe('planReconnect (pure)', () => {
  const MAX = 5;

  assert({
    given: 'a known persisted id still present in the live sessions',
    should: 'attach to it (reattach + replay scrollback)',
    actual: planReconnect({ knownId: 'sess-1', liveSessionIds: ['sess-1'], consecutiveFailures: 1, maxAttempts: MAX }),
    expected: { action: 'attach', id: 'sess-1' } as const,
  });

  assert({
    given: 'a known persisted id absent from the live sessions (dangling after a pause)',
    should: 'create a fresh session',
    actual: planReconnect({ knownId: 'sess-dead', liveSessionIds: ['sess-9'], consecutiveFailures: 1, maxAttempts: MAX }),
    expected: { action: 'create' } as const,
  });

  assert({
    given: 'a known persisted id and an empty live-session list',
    should: 'create a fresh session (the persisted id is gone)',
    actual: planReconnect({ knownId: 'sess-dead', liveSessionIds: [], consecutiveFailures: 1, maxAttempts: MAX }),
    expected: { action: 'create' } as const,
  });

  assert({
    given: 'no known id but a live shell session exists',
    should: 'attach to the first live session',
    actual: planReconnect({ knownId: undefined, liveSessionIds: ['sess-1'], consecutiveFailures: 1, maxAttempts: MAX }),
    expected: { action: 'attach', id: 'sess-1' } as const,
  });

  assert({
    given: 'no known id and no live sessions',
    should: 'be fatal (the shell is genuinely gone)',
    actual: planReconnect({ knownId: undefined, liveSessionIds: [], consecutiveFailures: 1, maxAttempts: MAX }),
    expected: { action: 'fatal' } as const,
  });

  assert({
    given: 'the consecutive failures exceed the bounded budget, even with a live known id',
    should: 'be fatal (never an infinite loop)',
    actual: planReconnect({ knownId: 'sess-1', liveSessionIds: ['sess-1'], consecutiveFailures: MAX + 1, maxAttempts: MAX }),
    expected: { action: 'fatal' } as const,
  });
});

describe('liveShellSessionIds (pure)', () => {
  assert({
    given: 'a mix of tty and non-tty sessions',
    should: 'return only the tty (shell) session ids',
    actual: liveShellSessionIds([
      { id: 'shell-1', command: 'bash', isActive: true, tty: true },
      { id: 'exec-1', command: 'ls', isActive: true, tty: false },
    ]),
    expected: ['shell-1'],
  });

  assert({
    given: 'an active and an inactive shell session',
    should: 'order the active shell first (mirrors pickShellSession)',
    actual: liveShellSessionIds([
      { id: 'shell-inactive', command: 'bash', isActive: false, tty: true },
      { id: 'shell-active', command: 'bash', isActive: true, tty: true },
    ]),
    expected: ['shell-active', 'shell-inactive'],
  });
});

describe('newTtySessionId (pure)', () => {
  assert({
    given: 'a new tty session appearing after a create alongside a pre-existing one',
    should: 'return the id absent from the before set (OUR new session, not the other terminal)',
    actual: newTtySessionId(['sess-other'], [
      { id: 'sess-other', command: 'bash', isActive: true, tty: true },
      { id: 'sess-new', command: 'bash', isActive: false, tty: true },
    ]),
    expected: 'sess-new',
  });

  assert({
    given: 'an empty before set and one new tty session',
    should: 'return that session id',
    actual: newTtySessionId([], [{ id: 'sess-new', command: 'bash', isActive: true, tty: true }]),
    expected: 'sess-new',
  });

  assert({
    given: 'no session appeared beyond the before set (ambiguous/empty diff)',
    should: 'return undefined so the caller persists nothing',
    actual: newTtySessionId(['sess-other'], [{ id: 'sess-other', command: 'bash', isActive: true, tty: true }]),
    expected: undefined,
  });

  assert({
    given: 'TWO new tty sessions appeared (a concurrent terminal created one in the same window)',
    should: 'return undefined — the diff can no longer tell which is ours, so persist nothing',
    actual: newTtySessionId(['sess-other'], [
      { id: 'sess-other', command: 'bash', isActive: true, tty: true },
      { id: 'sess-a', command: 'bash', isActive: false, tty: true },
      { id: 'sess-b', command: 'bash', isActive: false, tty: true },
    ]),
    expected: undefined,
  });

  assert({
    given: 'the only new session is non-tty (a plain exec, not a shell)',
    should: 'return undefined (a shell reattach target must be tty)',
    actual: newTtySessionId([], [{ id: 'exec-1', command: 'ls', isActive: true, tty: false }]),
    expected: undefined,
  });
});

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

    it('given a persisted id ABSENT from listSessions, creates a fresh session and reports the new id (not exit -1)', async () => {
      // Sprite paused: the persisted 'sess-dead' is dangling. Initial attach
      // errors; reconnect must verify against listSessions, see it's gone, and
      // fall back to a fresh session — overwriting the stale streamSessionId.
      const attachCmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const newSession: SpriteSessionInfo = { id: 'sess-fresh', command: 'bash', isActive: true, tty: true };
      const sprite = buildFakeSprite(freshCmd);
      sprite.attachSession.mockReturnValue(attachCmd);
      sprite.createSession.mockReturnValue(freshCmd);
      sprite.listSessions
        .mockResolvedValueOnce([])            // reconnect verification: sess-dead is gone
        .mockResolvedValueOnce([newSession]); // fresh session's background id capture
      const onExit = vi.fn();
      const onSessionId = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-dead', onOutput: vi.fn(), onExit, onSessionId });
      expect(sprite.attachSession).toHaveBeenCalledWith('sess-dead', { cols: 80, rows: 24 });

      attachCmd._emitter.emit('error', new Error('lost connection to shell'));
      await vi.advanceTimersByTimeAsync(500);

      expect(sprite.createSession).toHaveBeenCalledTimes(1);
      expect(onSessionId).toHaveBeenCalledWith('sess-fresh');
      expect(onExit).not.toHaveBeenCalled();
    });

    it('given the Sprite also hosts ANOTHER terminal tty session, the fallback reports only the NEW id (not the pre-existing one)', async () => {
      // Multi-terminal-per-Sprite: pickShellSession over all sessions could pick
      // the OTHER terminal's shell and persist its id — corrupting reattach. The
      // before/after diff must isolate our freshly created session.
      const attachCmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const otherTerminal: SpriteSessionInfo = { id: 'sess-other', command: 'bash', isActive: true, tty: true };
      const newShell: SpriteSessionInfo = { id: 'sess-new', command: 'bash', isActive: false, tty: true };
      const sprite = buildFakeSprite(freshCmd);
      sprite.attachSession.mockReturnValue(attachCmd);
      sprite.createSession.mockReturnValue(freshCmd);
      sprite.listSessions
        .mockResolvedValueOnce([otherTerminal])            // reconnect: our sess-dead is gone, but another terminal is live
        .mockResolvedValueOnce([otherTerminal, newShell]); // after create: our new shell joins
      const onSessionId = vi.fn();
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-dead', onOutput: vi.fn(), onExit, onSessionId });
      attachCmd._emitter.emit('error', new Error('lost connection to shell'));
      await vi.advanceTimersByTimeAsync(500);

      expect(sprite.createSession).toHaveBeenCalledTimes(1);
      expect(onSessionId).toHaveBeenCalledWith('sess-new');
      expect(onSessionId).not.toHaveBeenCalledWith('sess-other');
      expect(onExit).not.toHaveBeenCalled();
    });

    it('given the fallback diff is ambiguous (no new session appeared), reports NO id rather than a wrong one', async () => {
      const attachCmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const otherTerminal: SpriteSessionInfo = { id: 'sess-other', command: 'bash', isActive: true, tty: true };
      const sprite = buildFakeSprite(freshCmd);
      sprite.attachSession.mockReturnValue(attachCmd);
      sprite.createSession.mockReturnValue(freshCmd);
      sprite.listSessions
        .mockResolvedValueOnce([otherTerminal])  // reconnect snapshot (before)
        .mockResolvedValueOnce([otherTerminal]); // after create: diff yields nothing new
      const onSessionId = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-dead', onOutput: vi.fn(), onExit: vi.fn(), onSessionId });
      attachCmd._emitter.emit('error', new Error('lost connection to shell'));
      await vi.advanceTimersByTimeAsync(500);

      expect(sprite.createSession).toHaveBeenCalledTimes(1);
      expect(onSessionId).not.toHaveBeenCalled();
    });

    it('given listSessions fails transiently while a known id is held, optimistically reattaches to it instead of burning the budget', async () => {
      // Control-plane listSessions is briefly down; master reattached a known id
      // with no listSessions dependency, so a live shell must survive the blip.
      const initialAttach = buildFakeCommand();
      const reAttach = buildFakeCommand();
      const sprite = buildFakeSprite(buildFakeCommand());
      sprite.attachSession.mockReturnValueOnce(initialAttach).mockReturnValueOnce(reAttach);
      sprite.listSessions.mockRejectedValue(new Error('listSessions unavailable'));
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-1', onOutput: vi.fn(), onExit });
      initialAttach._emitter.emit('error', new Error('keepalive'));
      await vi.advanceTimersByTimeAsync(500);

      expect(sprite.attachSession).toHaveBeenCalledTimes(2); // initial + optimistic reattach
      expect(sprite.attachSession).toHaveBeenLastCalledWith('sess-1', { cols: 80, rows: 24 });
      expect(sprite.createSession).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();
    });

    it('given kill() fires while the reconnect listSessions await is in flight, does NOT create a leaked billable shell', async () => {
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(buildFakeCommand());
      sprite.attachSession.mockReturnValue(attachCmd);
      const d = deferred<SpriteSessionInfo[]>();
      sprite.listSessions.mockReturnValue(d.promise);
      const onExit = vi.fn();

      const shell = openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-dead', onOutput: vi.fn(), onExit });
      attachCmd._emitter.emit('error', new Error('keepalive'));
      await vi.advanceTimersByTimeAsync(300); // past backoff; now suspended at await listSessions

      shell.kill();               // closed = true mid-await
      d.resolve([]);              // sess-dead gone → would otherwise take the create branch
      await vi.advanceTimersByTimeAsync(0);

      expect(sprite.createSession).not.toHaveBeenCalled();
    });

    it('given a superseding reconnect lands before the fresh-fallback background resolve, the stale resolve does NOT persist its id', async () => {
      // Flapping Sprite: fallback A creates a session whose id-resolve is slow; a
      // second reconnect attaches a different live session first. A's late resolve
      // must not clobber currentSessionId / persist A's now-superseded id.
      const initialAttach = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const secondAttach = buildFakeCommand();
      const sprite = buildFakeSprite(freshCmd);
      sprite.attachSession.mockReturnValueOnce(initialAttach).mockReturnValueOnce(secondAttach);
      sprite.createSession.mockReturnValue(freshCmd);

      const d1 = deferred<SpriteSessionInfo[]>();     // reconnect #1 planning
      const dFresh = deferred<SpriteSessionInfo[]>(); // fallback A background resolve (stale)
      const d2 = deferred<SpriteSessionInfo[]>();     // reconnect #2 planning
      sprite.listSessions
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(dFresh.promise)
        .mockReturnValueOnce(d2.promise);
      const onSessionId = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-dead', onOutput: vi.fn(), onExit: vi.fn(), onSessionId });

      initialAttach._emitter.emit('error', new Error('drop1'));
      await vi.advanceTimersByTimeAsync(300);
      d1.resolve([]);                    // sess-dead gone → create fallback A (gen 1)
      await vi.advanceTimersByTimeAsync(0);

      freshCmd._emitter.emit('error', new Error('drop2'));
      await vi.advanceTimersByTimeAsync(600);
      d2.resolve([{ id: 'sess-live', command: 'bash', isActive: true, tty: true }]); // attach sess-live (gen 2)
      await vi.advanceTimersByTimeAsync(0);

      dFresh.resolve([{ id: 'sess-a', command: 'bash', isActive: false, tty: true }]); // stale resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(onSessionId).not.toHaveBeenCalledWith('sess-a');
    });

    it('given output flows from the fresh fallback session, forwards it to onOutput', async () => {
      const attachCmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const sprite = buildFakeSprite(freshCmd);
      sprite.attachSession.mockReturnValue(attachCmd);
      sprite.createSession.mockReturnValue(freshCmd);
      sprite.listSessions.mockResolvedValue([]); // sess-dead never returns; fresh id unresolved is fine
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-dead', onOutput, onExit: vi.fn() });
      attachCmd._emitter.emit('error', new Error('lost connection to shell'));
      await vi.advanceTimersByTimeAsync(500);

      freshCmd._stdout.emit('data', 'fresh prompt\r\n');
      expect(onOutput).toHaveBeenCalledWith('fresh prompt\r\n');
    });

    it('given a known id STILL present in listSessions, reattaches to it and does NOT create a fresh session', async () => {
      const attachInitial = buildFakeCommand();
      const attachAgain = buildFakeCommand();
      const sprite = buildFakeSprite(buildFakeCommand(), { sessions: [liveSession] });
      sprite.attachSession
        .mockReturnValueOnce(attachInitial)
        .mockReturnValueOnce(attachAgain);
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-1', onOutput: vi.fn(), onExit });
      attachInitial._emitter.emit('error', new Error('keepalive'));
      await vi.advanceTimersByTimeAsync(500);

      expect(sprite.attachSession).toHaveBeenLastCalledWith('sess-1', { cols: 80, rows: 24 });
      expect(sprite.createSession).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();
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
