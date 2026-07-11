import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { openPtyShell, planReconnect, liveShellSessionIds } from '../sprites-shell';

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

/**
 * The `session_info` control frame the server sends on a newly created session's
 * OWN socket — the authoritative source of that session's id (see
 * `readSessionInfoId`). A shell that never receives one holds no id and, by
 * design, will never attach to a session it cannot prove is its own.
 */
const announces = (id: string) => ({ type: 'session_info', session_id: id, command: 'bash', tty: true });

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
    given: 'no known id but a live shell session exists (possibly a SIBLING terminal\'s)',
    should: 'create a fresh session — never guess which live shell is ours',
    actual: planReconnect({ knownId: undefined, liveSessionIds: ['sess-1'], consecutiveFailures: 1, maxAttempts: MAX }),
    expected: { action: 'create' } as const,
  });

  assert({
    given: 'no known id and several live shells on the Sprite',
    should: 'still create — an id is only ever obtained authoritatively, never picked',
    actual: planReconnect({ knownId: undefined, liveSessionIds: ['sess-1', 'sess-2'], consecutiveFailures: 1, maxAttempts: MAX }),
    expected: { action: 'create' } as const,
  });

  assert({
    given: 'no known id and no live sessions',
    should: 'create a fresh session',
    actual: planReconnect({ knownId: undefined, liveSessionIds: [], consecutiveFailures: 1, maxAttempts: MAX }),
    expected: { action: 'create' } as const,
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
    given: 'an inactive and an active shell session',
    should: 'return both ids in list order — this is a membership set for verifying a KNOWN id, not a ranking to pick from',
    actual: liveShellSessionIds([
      { id: 'shell-inactive', command: 'bash', isActive: false, tty: true },
      { id: 'shell-active', command: 'bash', isActive: true, tty: true },
    ]),
    expected: ['shell-inactive', 'shell-active'],
  });
});

/**
 * Session identity comes from the create handle itself: the server sends a
 * `session_info` frame carrying `session_id` on the very socket `createSession()`
 * returned, so the id is known authoritatively and cannot be confused with a
 * sibling terminal's — no `listSessions()` diffing, no `is_active` guessing.
 */
describe('openPtyShell session identity (from create, not list-diffing)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('given a fresh create whose socket delivers session_info, reports that id WITHOUT ever listing sessions', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);
    const onSessionId = vi.fn();

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn(), onSessionId });
    cmd._emitter.emit('message', announces('sess-created'));

    expect(onSessionId).toHaveBeenCalledWith('sess-created');
    // The whole point of the leaf: the create path no longer snapshots/diffs.
    expect(sprite.listSessions).not.toHaveBeenCalled();
  });

  it('given TWO concurrent creates on ONE sprite, each shell reports its OWN id (never mis-attributed)', () => {
    // The racy case the old before/after diff could not resolve: two terminals
    // creating shells on the same Sprite in the same window. Each id arrives on
    // its own socket, so attribution is structural, not inferred.
    const cmdA = buildFakeCommand();
    const cmdB = buildFakeCommand();
    const sprite = buildFakeSprite(cmdA);
    sprite.createSession.mockReturnValueOnce(cmdA).mockReturnValueOnce(cmdB);
    const onSessionIdA = vi.fn();
    const onSessionIdB = vi.fn();

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn(), onSessionId: onSessionIdA });
    openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn(), onSessionId: onSessionIdB });

    // Frames interleave (B's lands first) — attribution must not depend on order.
    cmdB._emitter.emit('message', announces('sess-b'));
    cmdA._emitter.emit('message', announces('sess-a'));

    expect(onSessionIdA.mock.calls).toEqual([['sess-a']]);
    expect(onSessionIdB.mock.calls).toEqual([['sess-b']]);
  });

  it('given a non-session_info control frame, reports no id', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);
    const onSessionId = vi.fn();

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn(), onSessionId });
    cmd._emitter.emit('message', { type: 'port_open', port: 3000 });

    expect(onSessionId).not.toHaveBeenCalled();
  });

  it('given the created session announced its id, a later drop reattaches BY THAT ID (not by picking a live shell)', async () => {
    const cmd = buildFakeCommand();
    const attachCmd = buildFakeCommand();
    // The Sprite also hosts a sibling terminal's shell: the old pickShellSession
    // path could reattach to 'sess-sibling'. We must attach to our own id.
    const sprite = buildFakeSprite(cmd, {
      sessions: [
        { id: 'sess-sibling', command: 'bash', isActive: true, tty: true },
        { id: 'sess-mine', command: 'bash', isActive: false, tty: true },
      ],
      attachCmd,
    });

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
    cmd._emitter.emit('message', announces('sess-mine'));
    cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
    await vi.advanceTimersByTimeAsync(500);

    expect(sprite.attachSession).toHaveBeenCalledWith('sess-mine', { cols: 80, rows: 24 });
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
      cmd._emitter.emit('message', announces('sess-1')); // the session names itself
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
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);

      attachCmd._stdout.emit('data', 'back\r\n');
      expect(onOutput).toHaveBeenCalledWith('back\r\n');
    });

    it('given a drop with no announced id and NO live session, creates a fresh shell rather than exiting', async () => {
      const cmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [] });
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });
      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);

      expect(sprite.createSession).toHaveBeenCalledTimes(2);
      expect(onExit).not.toHaveBeenCalled();
      expect(onOutput).not.toHaveBeenCalledWith(expect.stringContaining('Shell error'));
    });

    it('given every reconnect attempt fails, should give up after the bounded budget and surface onExit(-1)', async () => {
      // A genuinely dead Sprite: each (re)created session's socket errors before
      // it ever opens, so no 'spawn'/stdout ever resets the budget.
      const sprite = buildFakeSprite(buildFakeCommand(), { listRejects: true });
      sprite.createSession.mockImplementation(() => {
        const next = buildFakeCommand();
        setTimeout(() => next._emitter.emit('error', new Error('WebSocket closed before open')), 0);
        return next;
      });
      const onOutput = vi.fn();
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });
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
      cmd._emitter.emit('message', announces('sess-1'));
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
      initial._emitter.emit('message', announces('sess-1'));

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
      cmd._emitter.emit('message', announces('sess-1'));
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

    it('given a persisted id ABSENT from listSessions, creates a fresh session and reports the NEW authoritative id (not exit -1)', async () => {
      // Sprite paused: the persisted 'sess-dead' is dangling. Initial attach
      // errors; reconnect must verify against listSessions, see it's gone, and
      // fall back to a fresh session — whose id comes from ITS OWN session_info
      // frame, overwriting the stale streamSessionId.
      const attachCmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const sprite = buildFakeSprite(freshCmd);
      sprite.attachSession.mockReturnValue(attachCmd);
      sprite.createSession.mockReturnValue(freshCmd);
      sprite.listSessions.mockResolvedValue([]); // reconnect verification: sess-dead is gone
      const onExit = vi.fn();
      const onSessionId = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-dead', onOutput: vi.fn(), onExit, onSessionId });
      expect(sprite.attachSession).toHaveBeenCalledWith('sess-dead', { cols: 80, rows: 24 });

      attachCmd._emitter.emit('error', new Error('lost connection to shell'));
      await vi.advanceTimersByTimeAsync(500);
      freshCmd._emitter.emit('message', announces('sess-fresh'));

      expect(sprite.createSession).toHaveBeenCalledTimes(1);
      expect(onSessionId).toHaveBeenCalledWith('sess-fresh');
      expect(onExit).not.toHaveBeenCalled();
    });

    it('given the Sprite also hosts ANOTHER terminal tty session, the fallback reports only OUR new id (never the sibling\'s)', async () => {
      // Multi-terminal-per-Sprite: the retired pickShellSession could pick the
      // OTHER terminal's shell and persist its id — pointing this terminal's next
      // cold connect at someone else's PTY. Our id now arrives on our own socket.
      const attachCmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const otherTerminal: SpriteSessionInfo = { id: 'sess-other', command: 'bash', isActive: true, tty: true };
      const sprite = buildFakeSprite(freshCmd);
      sprite.attachSession.mockReturnValue(attachCmd);
      sprite.createSession.mockReturnValue(freshCmd);
      // Our sess-dead is gone, but the sibling terminal's shell is live and active.
      sprite.listSessions.mockResolvedValue([otherTerminal]);
      const onSessionId = vi.fn();
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-dead', onOutput: vi.fn(), onExit, onSessionId });
      attachCmd._emitter.emit('error', new Error('lost connection to shell'));
      await vi.advanceTimersByTimeAsync(500);
      freshCmd._emitter.emit('message', announces('sess-new'));

      expect(sprite.createSession).toHaveBeenCalledTimes(1);
      expect(sprite.attachSession).not.toHaveBeenCalledWith('sess-other', expect.anything());
      expect(onSessionId).toHaveBeenCalledWith('sess-new');
      expect(onSessionId).not.toHaveBeenCalledWith('sess-other');
      expect(onExit).not.toHaveBeenCalled();
    });

    it('given the fresh fallback session announces NO id, reports none rather than a wrong one', async () => {
      const attachCmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const otherTerminal: SpriteSessionInfo = { id: 'sess-other', command: 'bash', isActive: true, tty: true };
      const sprite = buildFakeSprite(freshCmd);
      sprite.attachSession.mockReturnValue(attachCmd);
      sprite.createSession.mockReturnValue(freshCmd);
      sprite.listSessions.mockResolvedValue([otherTerminal]);
      const onSessionId = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-dead', onOutput: vi.fn(), onExit: vi.fn(), onSessionId });
      attachCmd._emitter.emit('error', new Error('lost connection to shell'));
      await vi.advanceTimersByTimeAsync(500);
      // No session_info frame ever arrives (the socket dropped pre-announce).

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

    it('given a superseding reconnect lands before a LATE session_info from a superseded session, the stale frame does NOT persist its id', async () => {
      // Flapping Sprite: fallback A creates a session, then drops before (or as)
      // its session_info lands; a second reconnect creates session B. A's late
      // frame must not clobber currentSessionId / persist A's superseded id.
      const initialAttach = buildFakeCommand();
      const freshA = buildFakeCommand();
      const freshB = buildFakeCommand();
      const sprite = buildFakeSprite(freshA);
      sprite.attachSession.mockReturnValue(initialAttach);
      sprite.createSession.mockReturnValueOnce(freshA).mockReturnValueOnce(freshB);
      sprite.listSessions.mockResolvedValue([]); // sess-dead is gone on every check
      const onSessionId = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-dead', onOutput: vi.fn(), onExit: vi.fn(), onSessionId });

      initialAttach._emitter.emit('error', new Error('drop1'));
      await vi.advanceTimersByTimeAsync(300); // sess-dead gone → create fallback A (gen 1)

      freshA._emitter.emit('error', new Error('drop2'));
      await vi.advanceTimersByTimeAsync(600); // → create fallback B (gen 2)
      freshB._emitter.emit('message', announces('sess-b'));

      // A's session_info arrives LATE, after B superseded it.
      freshA._emitter.emit('message', announces('sess-a'));

      expect(onSessionId).toHaveBeenCalledWith('sess-b');
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

    it('given the session id is unknown at reconnect, creates a fresh session instead of attaching to a live shell it cannot prove is ours', async () => {
      // The session never announced its id (socket died pre-session_info). A live
      // tty session IS listed — but it may be a sibling terminal's, and the old
      // pickShellSession path would have attached the user to it. We must not
      // guess: create fresh and learn the new id authoritatively.
      const cmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onExit = vi.fn();
      const onSessionId = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit, onSessionId });
      cmd._emitter.emit('error', new Error('keepalive'));
      await vi.advanceTimersByTimeAsync(500);
      freshCmd._emitter.emit('message', announces('sess-fresh'));

      expect(sprite.attachSession).not.toHaveBeenCalled();
      expect(sprite.createSession).toHaveBeenCalledTimes(2); // initial + fresh fallback
      expect(onSessionId).toHaveBeenCalledWith('sess-fresh');
      expect(onExit).not.toHaveBeenCalled();
    });
  });
});
