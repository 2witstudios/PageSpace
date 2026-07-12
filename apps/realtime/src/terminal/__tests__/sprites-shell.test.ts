import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { openPtyShell, planReconnect, sessionIds } from '../sprites-shell';
import { appendScrollback } from '../terminal-session-map';
import { spawnWithSelfHealingCwd } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { loggers } from '@pagespace/lib/logging/logger-config';

// riteway-style assertion (given/should/actual/expected) on top of vitest — the
// repo doesn't vendor riteway and bun-only rules forbid adding a dependency for
// a handful of pure-function cases, so keep the contract, drop the package.
function assert<T>({ given, should, actual, expected }: { given: string; should: string; actual: T; expected: T }): void {
  it(`given ${given}, should ${should}`, () => {
    expect(actual).toEqual(expected);
  });
}

// A promise the test settles by hand, to suspend reconnect() at its awaited
// listSessions() and act (e.g. kill the shell) while it is in flight.
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
  assert({
    given: 'a known persisted id still present in the live sessions',
    should: 'attach to it (reattach + replay scrollback)',
    actual: planReconnect({ knownId: 'sess-1', liveSessionIds: ['sess-1'] }),
    expected: { action: 'attach', id: 'sess-1' } as const,
  });

  assert({
    given: 'a known persisted id absent from the live sessions (dangling after a pause)',
    should: 'create a fresh session',
    actual: planReconnect({ knownId: 'sess-dead', liveSessionIds: ['sess-9'] }),
    expected: { action: 'create' } as const,
  });

  assert({
    given: 'a known persisted id and an empty live-session list',
    should: 'create a fresh session (the persisted id is gone)',
    actual: planReconnect({ knownId: 'sess-dead', liveSessionIds: [] }),
    expected: { action: 'create' } as const,
  });

  assert({
    given: 'no known id and several live shells on the Sprite',
    should: 'still create — an id is only ever obtained authoritatively, never picked',
    actual: planReconnect({ knownId: undefined, liveSessionIds: ['sess-1', 'sess-2'] }),
    expected: { action: 'create' } as const,
  });

  assert({
    given: 'no known id and no live sessions',
    should: 'create a fresh session',
    actual: planReconnect({ knownId: undefined, liveSessionIds: [] }),
    expected: { action: 'create' } as const,
  });
});

describe('sessionIds (pure)', () => {
  assert({
    given: 'the Sprite\'s live sessions',
    should: 'return every id — a membership set for verifying an id we already hold',
    actual: sessionIds([
      { id: 'shell-1', command: 'bash', isActive: true, tty: true },
      { id: 'shell-2', command: 'bash', isActive: false, tty: true },
    ]),
    expected: ['shell-1', 'shell-2'],
  });

  assert({
    given: 'sessions whose `tty` the SDK did not report (the published 0.0.1 build drops the field)',
    should: 'STILL return their ids — filtering on tty would verify nothing and orphan every live shell',
    actual: sessionIds([
      { id: 'shell-1', command: '/usr/bin/bash', isActive: true },
      { id: 'shell-2', command: '/usr/bin/bash', isActive: true },
    ]),
    expected: ['shell-1', 'shell-2'],
  });

  assert({
    given: 'no live sessions',
    should: 'return an empty set',
    actual: sessionIds([]),
    expected: [],
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

describe('spawnWithSelfHealingCwd', () => {
  assert({
    given: 'a command, its args, and a cwd',
    should: 'wrap them in an sh that recreates + enters the cwd, then execs the command',
    actual: spawnWithSelfHealingCwd({ command: 'bash', args: [], cwd: '/workspace' }),
    expected: [
      'sh',
      ['-c', 'mkdir -p "$1" 2>/dev/null; cd "$1" || exit 1; shift; exec "$@"', 'sh', '/workspace', 'bash'],
    ],
  });

  assert({
    given: 'a command with args',
    should: 'pass them as positional DATA after the command (never interpolated into the script)',
    actual: spawnWithSelfHealingCwd({ command: 'claude', args: ['--flag', 'v'], cwd: '/workspace' })[1].slice(3),
    expected: ['/workspace', 'claude', '--flag', 'v'],
  });

  assert({
    given: 'a cwd containing shell metacharacters',
    should: 'keep it a single positional arg, so it can never be evaluated as script',
    actual: spawnWithSelfHealingCwd({ command: 'bash', args: [], cwd: '/workspace; rm -rf /' })[1],
    expected: [
      '-c',
      'mkdir -p "$1" 2>/dev/null; cd "$1" || exit 1; shift; exec "$@"',
      'sh',
      '/workspace; rm -rf /',
      'bash',
    ],
  });
});

describe('openPtyShell', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('given a sprite and dimensions, should create a detachable session running bash in a self-healing cwd, with tty + dims + terminal env', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });

    // The cwd is NOT a createSession option: the server chdirs into it and fails
    // the open if it is gone, and a sandbox command can delete /workspace. It is
    // recreated + entered by the wrapper, which then execs bash — see `spawnWithSelfHealingCwd`.
    expect(sprite.createSession).toHaveBeenCalledWith(...spawnWithSelfHealingCwd({ command: 'bash', args: [], cwd: '/workspace' }), {
      tty: true,
      cols: 80,
      rows: 24,
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' },
    });
  });

  it('given a command/args (pluggable agent terminal), should create a session launching that command instead of bash', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);

    openPtyShell({ sprite, cols: 80, rows: 24, command: 'claude', args: ['--dangerously-skip-permissions'], onOutput: vi.fn(), onExit: vi.fn() });

    expect(sprite.createSession).toHaveBeenCalledWith(
      ...spawnWithSelfHealingCwd({ command: 'claude', args: ['--dangerously-skip-permissions'], cwd: '/workspace' }),
      {
        tty: true,
        cols: 80,
        rows: 24,
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' },
      },
    );
  });

  it('given a custom cwd, should create the session there instead of the default sandbox root', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);

    openPtyShell({ sprite, cols: 80, rows: 24, command: 'pagespace-cli', cwd: '/workspace/repo', onOutput: vi.fn(), onExit: vi.fn() });

    const [file, args] = sprite.createSession.mock.calls[0] as [string, string[]];
    expect([file, args]).toEqual(spawnWithSelfHealingCwd({ command: 'pagespace-cli', args: [], cwd: '/workspace/repo' }));
    expect(args).toContain('/workspace/repo');
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

    it('given a POST-open drop before the session announced its id, creates ONE replacement and never attaches to a SIBLING terminal\'s live shell', async () => {
      // Supersedes leaf 1-4's "post-open drop + nothing live => exit -1". That
      // exit existed because a fresh session could not be identified, so an
      // unnamed shell was indistinguishable from a dead one. It can be identified
      // now (the create socket announces it), so the right move is to replace it
      // and learn the new id — the user gets a prompt instead of a dead terminal.
      // Bounded: the replacement strands the unnameable session it left behind, so
      // a SECOND consecutive one fails loudly (see the ids-never-arrive test).
      //
      // The production shape: one Sprite hosts every terminal on the machine, so a
      // live tty session may well be someone else's — the retired pickShellSession
      // would have handed this user that PTY.
      const cmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const sibling: SpriteSessionInfo = { id: 'sess-sibling', command: 'claude', isActive: true, tty: true };
      const sprite = buildFakeSprite(cmd, { sessions: [sibling] });
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });
      // The socket OPENED first — a keepalive timeout is by definition a post-open
      // failure (the watchdog only fires after 45s of an established connection).
      // The real SDK emits 'spawn' at that open, and the shell keys on it: a
      // post-open death means a session WAS started, so replacing it strands that
      // session and is charged against the strand budget. (Contrast the cold-start
      // PRE-open drop, which never opened, started nothing, and is freely retried —
      // see cold-session-open-retry.test.ts.)
      cmd._emitter.emit('spawn');
      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);

      expect(sprite.attachSession).not.toHaveBeenCalled(); // the sibling is not ours to take
      expect(sprite.createSession).toHaveBeenCalledTimes(2);
      expect(onExit).not.toHaveBeenCalled();
      expect(onOutput).not.toHaveBeenCalledWith(expect.stringContaining('Shell error'));
    });

    it('given ids NEVER arrive, stops creating replacements instead of stranding a new billable shell every cycle', async () => {
      // The leak this bounds: an unnamed session cannot be reattached (no id) OR
      // killed (kill() signals over the socket that just died), yet a tty session
      // is detachable and keeps running — and billing. Each replacement strands
      // its predecessor. `spawn` resets the ordinary retry budget (the sockets DO
      // open; we simply never hear the session's name), so without a dedicated
      // bound this mints one orphan per keepalive cycle, forever.
      const created: FakeCommand[] = [];
      const sprite = buildFakeSprite(buildFakeCommand(), { sessions: [] });
      sprite.createSession.mockImplementation(() => {
        const next = buildFakeCommand();
        created.push(next);
        setTimeout(() => next._emitter.emit('spawn'), 0); // socket opens fine — budget resets
        return next;
      });
      const onOutput = vi.fn();
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });
      await vi.advanceTimersByTimeAsync(0);

      // Drop the shell repeatedly, far more often than the reconnect budget allows.
      for (let i = 0; i < 8; i += 1) {
        created[created.length - 1]._emitter.emit('error', new Error('WebSocket keepalive timeout'));
        await vi.advanceTimersByTimeAsync(2000);
      }

      // Bounded: the initial session + a single tolerated replacement, then it stops.
      expect(sprite.createSession).toHaveBeenCalledTimes(2);
      expect(onExit).toHaveBeenCalledWith(-1);
      expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('could not be identified'));
    });

    it('given two UNRELATED pre-announce drops with a healthy session in between, keeps the terminal alive (the strand budget is consecutive, not lifetime)', async () => {
      // Ids are demonstrably arriving — the middle session announced itself. A
      // lifetime counter would tear this healthy terminal down on the second rare
      // blip; the budget must mean "consecutively unnameable".
      const first = buildFakeCommand();
      const healthy = buildFakeCommand();
      const third = buildFakeCommand();
      const fourth = buildFakeCommand();
      const sprite = buildFakeSprite(first, { sessions: [] });
      sprite.createSession
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(healthy)
        .mockReturnValueOnce(third)
        .mockReturnValueOnce(fourth);
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit, onSessionId: vi.fn() });

      // Blip #1: socket opened, died before announcing → one tolerated strand.
      first._emitter.emit('spawn');
      first._emitter.emit('error', new Error('keepalive'));
      await vi.advanceTimersByTimeAsync(500);

      // The replacement is healthy and DOES announce itself → budget clears.
      healthy._emitter.emit('spawn');
      healthy._emitter.emit('message', announces('sess-healthy'));

      // Its id is now known, so a later drop verifies + creates fresh (session gone).
      healthy._emitter.emit('error', new Error('keepalive'));
      await vi.advanceTimersByTimeAsync(500);

      // Blip #2, much later and unrelated: again opened-then-dropped pre-announce.
      third._emitter.emit('spawn');
      third._emitter.emit('error', new Error('keepalive'));
      await vi.advanceTimersByTimeAsync(500);

      // Still alive: this is the FIRST consecutive strand, not the second ever.
      expect(onExit).not.toHaveBeenCalled();
      expect(sprite.createSession).toHaveBeenCalledTimes(4);
    });

    it('given the SDK emits `error` several times for ONE failed open, treats it as a single drop', async () => {
      // @fly/sprites fires 'error' from the ws error listener, from a
      // close-before-open, AND from spawn()'s catch on the rejected start() — up to
      // three times for one failure. Counting the echoes would burn the retry
      // budget and charge the strand budget for a session that never dropped.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('error', new Error('WebSocket error'));
      cmd._emitter.emit('error', new Error('WebSocket closed before open')); // echo
      cmd._emitter.emit('error', new Error('WebSocket closed before open')); // echo
      await vi.advanceTimersByTimeAsync(500);

      expect(sprite.attachSession).toHaveBeenCalledTimes(1);
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

    it('given the Sprite SDK throws while (re)opening a session, retries within the budget and recovers', async () => {
      // sprite.createSession/attachSession can throw synchronously (e.g. the SDK
      // fails to construct the WebSocket). That must be a bounded retry, not an
      // unhandled rejection that strands the terminal.
      const initial = buildFakeCommand();
      const recovered = buildFakeCommand();
      const sprite = buildFakeSprite(initial, { sessions: [] });
      sprite.createSession
        .mockReturnValueOnce(initial)
        .mockImplementationOnce(() => { throw new Error('failed to open WebSocket'); })
        .mockReturnValueOnce(recovered);
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit });
      initial._emitter.emit('error', new Error('keepalive'));
      await vi.advanceTimersByTimeAsync(2000); // throwing attempt, then the retry

      expect(sprite.createSession).toHaveBeenCalledTimes(3); // initial + throw + recovery
      expect(onExit).not.toHaveBeenCalled();
      recovered._stdout.emit('data', 'back\r\n'); // the recovered session is the live one
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

    it('given a REPLACEMENT command that errors the instant it is wired, does not re-enter a reconnect already in flight', async () => {
      // The `reconnecting` guard: reconnect() wires the new command BEFORE clearing
      // the flag, so a command that fails synchronously on wire re-enters reconnect
      // from inside itself. Without the guard that recurses; with it, the failure is
      // simply picked up by the next drop.
      const cmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      sprite.attachSession.mockImplementation(() => {
        const flapping = buildFakeCommand();
        const register = flapping.on.bind(flapping);
        // Fire 'error' the moment the shell subscribes — i.e. still inside reconnect().
        flapping.on = ((event: string, listener: (...a: unknown[]) => void) => {
          const result = register(event as 'error', listener as () => void);
          if (event === 'error') listener(new Error('flapped on open'));
          return result;
        }) as typeof flapping.on;
        return flapping;
      });

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('error', new Error('keepalive'));
      await vi.advanceTimersByTimeAsync(500);

      // One reattach — the re-entrant call was absorbed, not stacked.
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

  /**
   * Attaching to an exec session REPLAYS its scrollback (sprites.dev/api — "the
   * server immediately sends the session's scrollback buffer as stdout data").
   * That is the contract a fresh viewer wants and a transparent reconnect must
   * not honour: the watchdog reattaches an idle shell every ~45s, into an xterm
   * that already shows every byte being replayed.
   */
  describe('scrollback replay on in-place reconnect', () => {
    const BANNER = 'Welcome to PageSpace\r\nsandbox:~$ ';
    const outputs = (onOutput: ReturnType<typeof vi.fn>) => onOutput.mock.calls.map(([data]) => data as string);

    it('given a watchdog reconnect of an IDLE shell, replays nothing to the client (the repeated-banner repro)', async () => {
      const cmd = buildFakeCommand();
      const attach1 = buildFakeCommand();
      const attach2 = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      sprite.attachSession.mockReturnValueOnce(attach1).mockReturnValueOnce(attach2);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER); // the client now has the banner

      // Two full watchdog cycles on a shell that printed nothing in between.
      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach1._emitter.emit('spawn');
      attach1._stdout.emit('data', BANNER); // attach #1 replays it

      attach1._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach2._emitter.emit('spawn');
      attach2._stdout.emit('data', BANNER); // attach #2 replays it again

      // Exactly one banner, no matter how many times the watchdog fires.
      expect(outputs(onOutput)).toEqual([BANNER]);
    });

    it('given a reconnect attach that dies BEFORE it opens, keeps the history (an empty flush must not wipe it)', async () => {
      // A pre-open drop (cold Sprite wake, flapping WS) reaches closeReplayWindow on a command
      // that never received a byte, and the window closes over an empty hold. What this test
      // pins is `deliver`'s zero-length early return, which runs BEFORE the restart wipe: an
      // emission of no bytes must never replace the history, or one silent socket would erase
      // the anchor and the next attach would reprint the whole scrollback — the bug this module
      // exists to remove, fired by a socket that said nothing at all. (Delete that early return
      // and this test fails; it fires three times here.) `flushReplay` refusing to CALL an empty
      // flush a give-up is the other half — it stops a reprint being reported that never
      // happened — and that half is pinned in the pure test, not this one.
      const cmd = buildFakeCommand();
      const dies = buildFakeCommand();
      const replays = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      sprite.attachSession.mockReturnValueOnce(dies).mockReturnValueOnce(replays);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER); // the client has the banner

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      dies._emitter.emit('error', new Error('WebSocket error: closed before open')); // not one byte
      await vi.advanceTimersByTimeAsync(2000);
      replays._emitter.emit('spawn');
      replays._stdout.emit('data', BANNER); // the server replays it again

      expect(outputs(onOutput)).toEqual([BANNER]); // still exactly one banner
    });

    it('given kill() while a replay window is still open, leaves no timer armed against a shell nobody is watching', async () => {
      const cmd = buildFakeCommand();
      const attach = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      sprite.attachSession.mockReturnValueOnce(attach);

      const shell = openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach._emitter.emit('spawn');
      attach._stdout.emit('data', 'nothing here matches the anchor'); // held: window opens
      expect(vi.getTimerCount()).toBeGreaterThan(0); // settle + deadline are armed

      shell.kill();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('given a reconnect whose replay carries genuinely new output, emits exactly the new tail', async () => {
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      // The shell kept working while the socket was down: the replay is what the
      // client already has, PLUS what it missed.
      attachCmd._stdout.emit('data', `${BANNER}ls\r\nREADME.md\r\n`);

      expect(outputs(onOutput)).toEqual([BANNER, 'ls\r\nREADME.md\r\n']);
    });

    it('given a FRESH viewer attach (a cold connect to a persisted session), delivers the full scrollback exactly once', () => {
      // Nothing has been forwarded to this client, so there is nothing to dedupe
      // against — the replay IS the terminal's history and must arrive intact.
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(buildFakeCommand(), { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-1', onOutput, onExit: vi.fn() });
      attachCmd._stdout.emit('data', BANNER);

      expect(outputs(onOutput)).toEqual([BANNER]);
    });

    it('given a reconnect that CREATES a fresh session, passes its output through unchanged', async () => {
      // A new shell shares no history with the one the client saw, so even
      // byte-identical output is new: the anchor must reset with the session.
      const cmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [] }); // the known id is gone
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      freshCmd._stdout.emit('data', BANNER); // the replacement shell's own banner

      expect(outputs(onOutput)).toEqual([BANNER, BANNER]);
    });

    it('given a replay it cannot align (the server buffer trimmed past what we forwarded), emits it rather than losing it', async () => {
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', 'output we never forwarded\r\n');

      // Held back while the boundary might still turn up...
      expect(outputs(onOutput)).toEqual([BANNER]);
      // ...then released. Duplicating a redraw is survivable; swallowing the
      // session's output is not.
      await vi.advanceTimersByTimeAsync(1000);
      expect(outputs(onOutput)).toEqual([BANNER, 'output we never forwarded\r\n']);
    });

    it('given the handler\'s scrollback sink on the other end, appends the banner ONCE across repeated reconnects', async () => {
      // The suppression has to hold for the app-side buffer too, not just the
      // socket: `onOutput` is precisely where agent-terminal-handler appends to
      // `session.scrollback` before emitting. Bytes we never forward are bytes it
      // never appends — so a tab-back after an hour of idling replays one banner,
      // not eighty.
      const session = { scrollback: [] as string[], scrollbackBytes: 0 };
      const cmd = buildFakeCommand();
      const attach1 = buildFakeCommand();
      const attach2 = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      sprite.attachSession.mockReturnValueOnce(attach1).mockReturnValueOnce(attach2);

      openPtyShell({
        sprite,
        cols: 80,
        rows: 24,
        onOutput: (data) => appendScrollback(session, data),
        onExit: vi.fn(),
      });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach1._stdout.emit('data', BANNER);
      attach1._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach2._stdout.emit('data', BANNER);

      expect(session.scrollback.join('')).toBe(BANNER);
      expect(session.scrollbackBytes).toBe(Buffer.byteLength(BANNER, 'utf8'));
    });

    it('given ONE unaligned flush on an idle terminal, keeps deduping on every later cycle (never latches the bug)', async () => {
      // The worst failure this module can have, and the subtlest: an unaligned flush that
      // APPENDS the replayed bytes to the history. Those bytes duplicate history we already
      // hold, so the history stops being a contiguous run of the session's stream — and for
      // an idle terminal, whose whole history is smaller than the anchor bound, the anchor
      // IS that history. A broken run matches no replay ever again. One transient blip would
      // permanently restore "the banner reprints every 45s" — this module's own bug, latched.
      const cmd = buildFakeCommand();
      const attaches = [
        buildFakeCommand(), buildFakeCommand(), buildFakeCommand(),
        buildFakeCommand(), buildFakeCommand(),
      ];
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      attaches.forEach((a) => sprite.attachSession.mockReturnValueOnce(a));
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      // Cycle 1: the socket dies MID-REPLAY, so the window closes on a partial ring that
      // cannot be aligned — it goes out verbatim.
      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attaches[0]._emitter.emit('spawn');
      attaches[0]._stdout.emit('data', BANNER.slice(0, 12)); // a prefix: unalignable
      attaches[0]._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(2000);

      // Cycle 2 completes what the blip left half-said (the history restarted at that
      // prefix, so the rest of the ring is genuinely new to it) — a bounded, one-off cost.
      attaches[1]._emitter.emit('spawn');
      attaches[1]._stdout.emit('data', BANNER);
      await vi.advanceTimersByTimeAsync(2000);
      const afterRecovery = outputs(onOutput).join('');

      // ...and from here the history is a clean run again: three further idle cycles must
      // emit NOTHING. A latched history would reprint the banner on every one of them.
      for (let i = 2; i <= 4; i += 1) {
        attaches[i - 1]._emitter.emit('error', new Error('WebSocket keepalive timeout'));
        await vi.advanceTimersByTimeAsync(500);
        attaches[i]._emitter.emit('spawn');
        attaches[i]._stdout.emit('data', BANNER); // the full ring, replayed
        await vi.advanceTimersByTimeAsync(2000);
      }

      expect(outputs(onOutput).join('')).toBe(afterRecovery); // recovered, and stayed recovered
    });

    it('given an unalignable replay whose window closes, REPORTS it', async () => {
      // The terminal is reprinting its scrollback rather than deduping, and an operator can
      // only see that if we say so. This path had no test: deleting the report left the whole
      // suite green.
      const warn = vi.spyOn(loggers.realtime, 'warn');
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput: vi.fn(), onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', 'a ring that never carries the anchor');
      await vi.advanceTimersByTimeAsync(2000); // settle, then the window deadline

      const reported = warn.mock.calls.filter(
        ([, meta]) => (meta as { cause?: string } | undefined)?.cause === 'window-closed',
      );
      warn.mockRestore(); // before the assertion: a failing expect must not leak the spy
      expect(reported.length).toBeGreaterThan(0);
    });

    it('given a replay that overflows the byte cap, REPORTS it (the one give-up that never reaches the window close)', async () => {
      // A ring bigger than MAX_PENDING_BYTES is the cause that does not heal: the anchor sits
      // at a replay's END, so the cap trips before it ever arrives, and the scrollback reprints
      // on every reconnect until the cap is raised past the ring. It is also the give-up that
      // resolves inside the pure core — `closeReplayWindow`, and its log, never run. If it did
      // not report here, the failure the cap exists to catch would be the only silent one.
      const warn = vi.spyOn(loggers.realtime, 'warn');
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      // A ring larger than the cap, arriving in frames — so it overflows before the anchor.
      const frame = 'z'.repeat(512 * 1024);
      for (let i = 0; i < 9; i += 1) attachCmd._stdout.emit('data', `frame ${i} ${frame}`);
      await vi.advanceTimersByTimeAsync(2000);

      const reported = warn.mock.calls.filter(
        ([, meta]) => (meta as { cause?: string } | undefined)?.cause === 'pending-cap',
      );
      warn.mockRestore(); // before the assertion: a failing expect must not leak the spy
      expect(reported.length).toBeGreaterThan(0); // it says so, instead of failing silently
    });

    it('given a replay that overflows the byte cap, emits it and leaves a usable history', async () => {
      // The other give-up path: the replay never aligns and grows past MAX_PENDING_BYTES, so
      // the pure core emits it verbatim rather than the window timer. (Whether that emission
      // 'restarts' or 'appends' the history is unobservable HERE by construction — it is
      // larger than the whole history, so the retention trim evicts the past either way. The
      // flag itself is asserted at the source, in replay-dedupe.test.ts.) What this pins is
      // what the shell must guarantee: the bytes reach the user, and the history that comes
      // out the other side still dedupes.
      const cmd = buildFakeCommand();
      const attach1 = buildFakeCommand();
      const attach2 = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      sprite.attachSession.mockReturnValueOnce(attach1).mockReturnValueOnce(attach2);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      // Unique lines, not padding: self-similar bytes let the anchor match early (the
      // documented content-matching limitation) and would test nothing here.
      const flood = `unalignable ${Array.from({ length: 220_000 }, (_, i) => `line ${i} of the flood\r\n`).join('')}`;
      attach1._stdout.emit('data', flood);
      await vi.advanceTimersByTimeAsync(2000);
      expect(outputs(onOutput).join('')).toContain('unalignable'); // emitted, not swallowed

      const afterOverflow = outputs(onOutput).join('');

      // The history restarted from those bytes, so replaying them again dedupes. Note this
      // fake delivers the whole flood in ONE frame, and the anchor search runs before the
      // overflow check — so it is found. A real over-cap ring arrives in many frames and
      // overflows first, and THAT reprints on every cycle: which is why the cap has to exceed
      // the server's ring (see MAX_PENDING_BYTES). What this pins is the recovery, not a
      // claim that an over-cap ring heals.
      attach1._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach2._stdout.emit('data', flood);
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput).join('')).toBe(afterOverflow); // nothing reprinted
    });

    it('given a CHATTY shell across the reconnect, emits within the replay window instead of stalling to the byte cap', async () => {
      // The quiet-gap timer alone is not a bound: a build or a repainting TUI
      // never goes quiet, so every chunk would re-arm it and the terminal would
      // sit dead all the way to MAX_PENDING_BYTES. The hard window is what makes the worst
      // case a redraw rather than a multi-megabyte stall.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);

      // An unalignable replay (the server buffer trimmed past our anchor) followed
      // by a stream that never pauses long enough to trip the quiet timer.
      for (let i = 0; i < 20; i += 1) {
        attachCmd._stdout.emit('data', `build step ${i}\r\n`);
        await vi.advanceTimersByTimeAsync(100); // < REPLAY_SETTLE_MS every time
      }

      // The window closed on its deadline and the output flowed.
      const seen = outputs(onOutput).join('');
      expect(seen).toContain('build step 0\r\n');
      expect(seen).toContain('build step 19\r\n');
    });

    it('given an unalignable replay whose anchor RECURS in live output moments later, swallows nothing', async () => {
      // The loss path, at the shell level and INSIDE the replay window (a repaint
      // arriving after the window closes can't reach the search at all). A long
      // session, a replay the ring has trimmed past, and a TUI that repaints the
      // exact bytes the client last saw. An unanchored match lands past the true
      // boundary and drops the output in front of it — output nobody has ever seen.
      const line = (p: string, n: number) =>
        Array.from({ length: n }, (_, i) => `${p} ${i}\r\n`).join('');
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      // A session with far more history than the 8 KiB anchor — the only shape in
      // which a replay can be unalignable at all.
      const history = line('history', 3000);
      const tail = line('recent', 800);
      cmd._stdout.emit('data', history + tail);
      const delivered = outputs(onOutput).join('');
      const repaint = delivered.slice(-8 * 1024); // exactly the bytes the anchor holds

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);

      // The replay the client has never seen (the ring trimmed past our anchor)...
      attachCmd._stdout.emit('data', 'work the client never saw\r\n');
      await vi.advanceTimersByTimeAsync(50); // still well inside the replay window
      // ...immediately followed by a repaint of the anchor's exact bytes.
      attachCmd._stdout.emit('data', `${repaint}after repaint\r\n`);
      await vi.advanceTimersByTimeAsync(2000);

      const shown = outputs(onOutput).join('');
      expect(shown).toContain('work the client never saw\r\n'); // NOT swallowed
      expect(shown).toContain('after repaint\r\n');
    });

    it('given the socket dies while replay bytes are buffered and the reconnect CREATES a fresh session, still delivers them', async () => {
      // Those bytes exist nowhere else: a fresh session has no scrollback to replay
      // them from, and nothing appended them to the app-side buffer. Dropping them
      // loses the dying shell's last words for good.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', 'segfault: dumping core\r\n'); // buffered, unaligned
      // The session dies with the Sprite before the window closes.
      sprite.listSessions.mockResolvedValue([]);
      attachCmd._emitter.emit('spawn');
      attachCmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(1000);

      expect(outputs(onOutput).join('')).toContain('segfault: dumping core\r\n');
    });

    it('given a drain that arrives BEFORE the replay, delivers it exactly once (the replay recognises it)', async () => {
      // The ordinary shape: a dying socket flushes its buffer at once, while the new one
      // still has a backoff and a handshake ahead of it. So the drain lands first — and
      // because the history is snapshotted on the new command's FIRST inbound byte, those
      // bytes are already in the anchor. The replay that also carries them recognises them
      // and suppresses them. Delivered once, in order, with no bookkeeping to get wrong.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500); // attachCmd is wired, but has sent nothing
      cmd._stdout.emit('data', 'X'); // the dead socket drains, late
      attachCmd._stdout.emit('data', `${BANNER}X`); // the real scrollback contains it
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput).join('')).toBe(`${BANNER}X`); // once — not twice, not torn
    });

    it('given a dead socket drains a byte AFTER its replacement is wired, keeps deduping on every later cycle', async () => {
      // The poisoning case. A stale command's late drain must not be recorded into
      // the history: the replacement already took its snapshot (and, on the create
      // path, reset it), so that byte belongs to no session's stream. Recorded, it
      // makes the anchor chimeric — it matches nothing, forever, because an idle
      // shell never emits the 8 KiB of fresh output needed to scroll it out. The
      // banner would then reprint on EVERY watchdog cycle: the very bug this fixes,
      // made permanent.
      const cmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [], attachCmd }); // known id is gone -> create
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', 'old session output\r\n');

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500); // the replacement is wired by now
      cmd._stdout.emit('data', 'X'); // the dead socket drains, late

      // The fresh shell prints its banner, and a later watchdog cycle replays it.
      freshCmd._emitter.emit('message', announces('sess-2'));
      freshCmd._emitter.emit('spawn');
      freshCmd._stdout.emit('data', BANNER);
      sprite.listSessions.mockResolvedValue([{ id: 'sess-2', command: 'bash', isActive: true, tty: true }]);
      freshCmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', BANNER); // the replay
      await vi.advanceTimersByTimeAsync(2000); // let the window close, so a duplicate would surface

      // The drained byte reached the user, and the banner still appears exactly once.
      const shown = outputs(onOutput).join('');
      expect(shown).toContain('X');
      expect(shown.split(BANNER).length - 1).toBe(1);
    });

    it('given a session with FAR more history than the anchor, still dedupes a full-ring replay', async () => {
      // Every other shell test here uses a 33-byte banner, i.e. `seen` smaller than
      // MAX_ANCHOR_BYTES — the regime where the anchor is the whole of `seen` and
      // trivially matches. Production leaves that regime within seconds. This is the
      // real shape: a long-running session, an 8 KiB anchor taken from the tail of a
      // 64 KiB history, and a replay carrying the whole ring.
      const line = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p} ${i}\r\n`).join('');
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      const history = line('build step', 4000); // ~65 KiB, well past the 8 KiB anchor
      cmd._stdout.emit('data', history);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      // The server replays its whole ring, then the shell prints one new line.
      attachCmd._stdout.emit('data', `${history}$ echo done\r\n`);
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput)).toEqual([history, '$ echo done\r\n']);
    });

    it('given a drain that lands BEFORE the reconnect wires a successor, records it (the next replay dedupes it)', async () => {
      // The ordinary case: the SDK drains the dying socket's buffer immediately, well
      // inside the reconnect's backoff. This command is still the wired one, so those
      // bytes ARE part of the stream the next attach will replay — record them, or the
      // replay would re-deliver them as if they were new.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      cmd._stdout.emit('data', 'last words\r\n'); // drained while still wired
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', `${BANNER}last words\r\n`); // the replay carries them
      await vi.advanceTimersByTimeAsync(2000);

      // Delivered exactly once: the replay of them was recognised and suppressed.
      expect(outputs(onOutput).join('')).toBe(`${BANNER}last words\r\n`);
    });

    it('given a drain from a session the wired command is NOT attached to, emits it (that scrollback never held it)', async () => {
      // The loss a mere "is an attach wired?" boolean causes. sess-1 dies and is replaced
      // by a fresh sess-2; sess-2's socket then drops and is REATTACHED. Now sess-1's
      // long-dead socket drains its last words. A boolean says "an attach is wired, a
      // replay is coming" — but the replay coming is sess-2's, and sess-2's scrollback has
      // never held a byte of sess-1's output. Held, those bytes are lost for good.
      const cmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [], attachCmd });
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      // sess-1's Sprite paused: the reconnect CREATES sess-2.
      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      freshCmd._emitter.emit('message', announces('sess-2'));
      freshCmd._emitter.emit('spawn');
      freshCmd._stdout.emit('data', '$ ');

      // sess-2's socket now drops, and sess-2 is still live, so it is REATTACHED.
      sprite.listSessions.mockResolvedValue([{ id: 'sess-2', command: 'bash', isActive: true, tty: true }]);
      freshCmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);

      // ...and only NOW does sess-1's dead socket drain.
      cmd._stdout.emit('data', 'sess-1 last words\r\n');
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput).join('')).toContain('sess-1 last words\r\n');
    });

    it('given a drain that arrives after the replay already carried it, repeats it rather than risking its loss', async () => {
      // The one case the drain is NOT deduped: it lands after the replay's first byte, so
      // it missed the history snapshot that would have let the replay recognise it. It is
      // shown twice. Suppressing it instead would need a proof that the replay really did
      // carry it — and nothing can give that proof (the replay may be a prefix, the socket
      // may die, the session may be gone). Four attempts at such a proof each cost bytes.
      // A repeated line is survivable; a swallowed panic is not.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', `${BANNER}X`); // the replay lands FIRST and delivers X
      await vi.advanceTimersByTimeAsync(2000);
      cmd._stdout.emit('data', 'X'); // ...and only now does the dead socket drain its copy

      expect(outputs(onOutput).join('')).toBe(`${BANNER}XX`); // shown twice, never lost
    });

    it('given a drain on the OPTIMISTIC reattach (listSessions unavailable), still lets the replay deliver it', async () => {
      // The reconnect can reattach without verifying, when the control plane's session
      // list is momentarily unavailable. That is still a reattach — the session's
      // scrollback still carries the drain — so the same rule must hold on this path.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd, listRejects: true });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500); // listSessions threw -> optimistic reattach
      expect(sprite.attachSession).toHaveBeenCalledWith('sess-1', { cols: 80, rows: 24 });
      cmd._stdout.emit('data', 'X'); // drained late
      attachCmd._stdout.emit('data', `${BANNER}X`); // the replay carries it

      expect(outputs(onOutput).join('')).toBe(`${BANNER}X`); // once — not twice
    });

    it('given a drain that arrives AFTER a fresh session replaced a REATTACHED one, emits it (nothing will replay it)', async () => {
      // The flag says "a replay is coming for this drain". A create must clear it: the
      // shell reattached first (so it was true), and now the session is gone. A drain
      // arriving after the fresh shell is wired would otherwise be held for a replay that
      // will never exist — and lost.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      // First reconnect REATTACHES (so "a replay is coming" is now true)...
      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', BANNER);
      await vi.advanceTimersByTimeAsync(2000);

      // ...then the session dies with the Sprite and the next reconnect CREATES.
      sprite.listSessions.mockResolvedValue([]);
      attachCmd._emitter.emit('spawn');
      attachCmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(1000);
      // The dead attach socket drains its last words. No replay is coming for them now.
      attachCmd._stdout.emit('data', 'panic: goodbye\r\n');

      expect(outputs(onOutput).join('')).toContain('panic: goodbye\r\n');
    });

    it('given the replay ALREADY delivered the drain, a later fresh session does not repeat it', async () => {
      // The other half of holding the drain: once a replay has actually carried those
      // bytes to the client, they must not be shown again. Otherwise the next fresh session
      // — which flushes what it is holding, on the grounds that nothing will replay it —
      // would hand the user the same bytes a second time.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      cmd._stdout.emit('data', 'X'); // drained late; recorded, so the replay recognises it
      attachCmd._stdout.emit('data', `${BANNER}X`); // the replay delivers it
      await vi.advanceTimersByTimeAsync(2000);

      // Now the session dies for real and the next reconnect starts a fresh shell.
      sprite.listSessions.mockResolvedValue([]);
      attachCmd._emitter.emit('spawn');
      attachCmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(1000);
      freshCmd._stdout.emit('data', '$ ');

      const shown = outputs(onOutput).join('');
      expect(shown.split('X').length - 1).toBe(1); // delivered once, by the replay
      expect(shown).toBe(`${BANNER}X$ `);
    });

    it('given an UNALIGNABLE replay, the drain still arrives and the history still recovers', async () => {
      // The give-up path: the ring could not be aligned, so it is re-emitted verbatim —
      // duplicating what the client already had, drain included. That is the accepted cost.
      // What must NOT happen is the history keeping that duplicate: an unaligned flush
      // RESTARTS the history with the replayed bytes (which are themselves a contiguous run
      // of the stream), so the next cycle dedupes normally instead of reprinting forever.
      const cmd = buildFakeCommand();
      const attach1 = buildFakeCommand();
      const attach2 = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      sprite.attachSession.mockReturnValueOnce(attach1).mockReturnValueOnce(attach2);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      cmd._stdout.emit('data', 'X'); // drained before the replay: recorded, dedupable
      // The server's ring trimmed past our anchor, so this replay cannot be aligned.
      attach1._stdout.emit('data', 'unalignable scrollback X');
      await vi.advanceTimersByTimeAsync(2000);

      const afterFlush = outputs(onOutput).join('');
      expect(afterFlush).toContain('X'); // the drain reached the user
      expect(afterFlush).toContain('unalignable scrollback X'); // and so did the ring

      // The history restarted from the replayed bytes, so the NEXT cycle dedupes cleanly.
      attach1._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach2._stdout.emit('data', 'unalignable scrollback X'); // the same ring, replayed
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput).join('')).toBe(afterFlush); // nothing reprinted
    });

    it('given a drain, a PARTIAL replay, then a socket death and a fresh session, delivers the drain exactly once', async () => {
      // A drain is never withheld waiting for a replay to carry it — that idea was tried and
      // it cost bytes every time. It is delivered when it arrives, and recorded, so the replay
      // that also carries it recognises it. Here the replay never completes (the socket dies
      // mid-burst) and the session is gone by the next reconnect: nothing else will ever
      // deliver those bytes, and nothing must deliver them twice either.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500); // reattached to sess-1
      cmd._stdout.emit('data', 'panic: goodbye\r\n'); // the dying socket's last words

      // The replay starts arriving — and the socket dies MID-BURST.
      attachCmd._emitter.emit('spawn');
      attachCmd._stdout.emit('data', `${BANNER}panic: goodbye\r\n`.slice(0, 10)); // a prefix
      sprite.listSessions.mockResolvedValue([]); // the session died with the Sprite
      attachCmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(1000);
      freshCmd._emitter.emit('spawn');
      freshCmd._stdout.emit('data', '$ '); // the replacement shell
      await vi.advanceTimersByTimeAsync(2000);

      const shown = outputs(onOutput).join('');
      expect(shown.split('panic: goodbye\r\n').length - 1).toBe(1); // exactly once
    });

    it('given the terminal exits immediately after a drain, delivers it and still exits cleanly', async () => {
      // The likeliest shape in the wild: the shell panics — that panic IS the drain — its
      // socket dies, we reattach, and the reattached session reports the exit. The user must
      // see why the terminal closed.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500); // reattached
      cmd._stdout.emit('data', 'panic: goodbye\r\n');
      attachCmd._emitter.emit('exit', 0); // the shell is gone

      const shown = outputs(onOutput).join('');
      expect(shown.split('panic: goodbye\r\n').length - 1).toBe(1); // delivered, exactly once
      expect(onExit).toHaveBeenCalledWith(0);
    });

    it('given an UNNAMED dead session, a fresh UNNAMED session neither claims nor records its drain', async () => {
      // Both bindings have an undefined id until their sessions announce themselves, so an
      // id-only comparison reads `undefined === undefined` as "same session" — and the fresh
      // session, which has not snapshotted yet, would RECORD the dead one's bytes as its own
      // history. That history then contains bytes no replay of the new session can ever
      // hold, so its anchor matches nothing and the banner reprints on every later cycle.
      const cmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [], attachCmd });
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('spawn'); // never announces an id
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500); // a fresh session is wired; it has no id yet
      cmd._stdout.emit('data', 'panic: last words\r\n'); // the dead socket drains, unrecorded
      freshCmd._emitter.emit('message', announces('sess-2'));
      freshCmd._emitter.emit('spawn');
      freshCmd._stdout.emit('data', BANNER); // the new shell's own banner

      // Delivered AT ONCE. Had the drain been recorded as this session's history, its banner
      // would not have matched that history, so it would have been held as an unalignable
      // replay and only released when the window timed out — a needless half-second stall on
      // a brand-new shell, and a give-up flush that exists for nothing.
      expect(outputs(onOutput).join('').endsWith(BANNER)).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);

      const afterCreate = outputs(onOutput).join('');
      expect(afterCreate).toContain('panic: last words\r\n'); // delivered

      // The new session's history is clean, so its own idle cycle dedupes.
      sprite.listSessions.mockResolvedValue([{ id: 'sess-2', command: 'bash', isActive: true, tty: true }]);
      freshCmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', BANNER); // sess-2's replay
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput).join('')).toBe(afterCreate); // nothing reprinted
    });

    it('given a drain from ANOTHER session landing before the fresh one speaks, does not record it', async () => {
      // The `sameSession` half of the guard. The dead session is NAMED and the fresh one is
      // NAMED — different ids — and the drain lands in the window before the fresh session's
      // first byte, i.e. while it could still be recorded. Recording it would splice bytes
      // into the new session's history that its scrollback can never contain.
      const cmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [], attachCmd });
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500); // sess-1 is gone; sess-2 is wired
      freshCmd._emitter.emit('message', announces('sess-2'));
      cmd._stdout.emit('data', 'sess-1 last words\r\n'); // drains BEFORE sess-2 says anything
      freshCmd._emitter.emit('spawn');
      freshCmd._stdout.emit('data', BANNER);

      // Delivered AT ONCE — see the unnamed case above: a drain recorded as this session's
      // history would leave its own banner unalignable, held, and released only on a timeout.
      const shownNow = outputs(onOutput).join('');
      expect(shownNow.endsWith(BANNER)).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);

      const afterCreate = outputs(onOutput).join('');
      expect(afterCreate).toContain('sess-1 last words\r\n'); // delivered

      sprite.listSessions.mockResolvedValue([{ id: 'sess-2', command: 'bash', isActive: true, tty: true }]);
      freshCmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', BANNER); // sess-2's replay
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput).join('')).toBe(afterCreate); // sess-2's history was never poisoned
    });

    it('given the REATTACH dies before replaying, the fresh session delivers the drain WITHOUT poisoning the history', async () => {
      // Why the drain is HELD rather than dropped: the reattach's replay is expected to
      // carry it, but that attach can die before its replay ever lands, and if the session
      // is gone by the next reconnect its scrollback died with it. Nobody would deliver
      // those bytes. The fresh session hands them over instead — but must NOT record them
      // into `seen`: they are no part of the new session's stream, and splicing them in
      // would leave every later replay unmatchable, reprinting the banner forever.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const attach2 = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      sprite.attachSession.mockReturnValueOnce(attachCmd).mockReturnValueOnce(attach2);
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500); // reattached to sess-1
      cmd._stdout.emit('data', 'panic: goodbye\r\n'); // drained late; recorded with the history

      // ...but the reattach dies before replaying anything, and the session is gone now.
      sprite.listSessions.mockResolvedValue([]);
      attachCmd._emitter.emit('spawn');
      attachCmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(1000);
      freshCmd._emitter.emit('message', announces('sess-2'));
      freshCmd._emitter.emit('spawn');
      freshCmd._stdout.emit('data', BANNER); // the new shell's own banner
      await vi.advanceTimersByTimeAsync(2000);

      const afterCreate = outputs(onOutput).join('');
      expect(afterCreate).toContain('panic: goodbye\r\n'); // the last words survived

      // The new session's history is clean, so its own idle cycles still dedupe.
      sprite.listSessions.mockResolvedValue([{ id: 'sess-2', command: 'bash', isActive: true, tty: true }]);
      freshCmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach2._stdout.emit('data', BANNER); // sess-2's replay
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput).join('')).toBe(afterCreate); // nothing reprinted
    });

    it('given a drain that lands BETWEEN replay frames, never tears the replay nor poisons the history', async () => {
      // A scrollback burst is not one WebSocket frame, and the dead socket's events are
      // separate macrotasks from the new socket's — so a drain can land mid-replay. It is
      // delivered (it may then be repeated by the rest of the replay: the race above), but
      // the replay itself must not be TORN, and the history must survive: an idle terminal
      // that stops deduping never starts again.
      const cmd = buildFakeCommand();
      const attach1 = buildFakeCommand();
      const attach2 = buildFakeCommand();
      const attach3 = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      sprite.attachSession
        .mockReturnValueOnce(attach1)
        .mockReturnValueOnce(attach2)
        .mockReturnValueOnce(attach3);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      const scrollback = `${BANNER}X`;
      attach1._stdout.emit('data', scrollback.slice(0, 14));
      cmd._stdout.emit('data', 'X'); // the drain, mid-replay
      attach1._stdout.emit('data', scrollback.slice(14));
      await vi.advanceTimersByTimeAsync(2000);

      const afterRace = outputs(onOutput).join('');
      expect(afterRace).toContain('X'); // delivered, whatever else happened

      // ...and the history still works: two ordinary idle cycles dedupe cleanly.
      attach1._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach2._stdout.emit('data', scrollback);
      await vi.advanceTimersByTimeAsync(2000);
      attach2._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach3._stdout.emit('data', scrollback);
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput).join('')).toBe(afterRace); // nothing reprinted, ever
    });

    it('given stderr while a replay is being held, releases it AFTER the held stdout (never dropped, never ahead)', async () => {
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', 'unalignable stdout\r\n'); // held
      attachCmd._stderr.emit('data', 'a warning\r\n'); // must not jump it, must not vanish
      await vi.advanceTimersByTimeAsync(2000);

      const shown = outputs(onOutput).join('');
      expect(shown).toContain('a warning\r\n');
      expect(shown.indexOf('unalignable stdout')).toBeLessThan(shown.indexOf('a warning'));
    });

    it('given stderr from a SUPERSEDED command, does not jump the replay its successor is holding', async () => {
      // Same reordering hazard as the stdout drain: the dead command's own window is
      // long closed, so without the guard its bytes would render ahead of the older
      // stdout the live command is still holding.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', 'unalignable output\r\n'); // held
      cmd._stderr.emit('data', 'late stderr\r\n'); // the dead command speaks
      await vi.advanceTimersByTimeAsync(2000);

      // The held stdout came out FIRST, then the late stderr — wire order preserved.
      const shown = outputs(onOutput).join('');
      expect(shown.indexOf('unalignable output')).toBeLessThan(shown.indexOf('late stderr'));
    });

    it('given held stderr released when the replay RESOLVES, delivers it and keeps deduping later', async () => {
      // Two guards at once. (1) The resolve path must release held stderr: on an idle
      // shell nothing else ever fires, so it would be lost silently. (2) The release must
      // NOT record it into the history — the server replays stdout, so stderr bytes in
      // `seen` are bytes no replay can contain, and the anchor would stop matching for the
      // life of the terminal.
      const cmd = buildFakeCommand();
      const attach1 = buildFakeCommand();
      const attach2 = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      sprite.attachSession.mockReturnValueOnce(attach1).mockReturnValueOnce(attach2);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      // The replay arrives in two frames; stderr lands while the first is still held.
      attach1._stdout.emit('data', BANNER.slice(0, 14));
      attach1._stderr.emit('data', 'a warning\r\n');
      attach1._stdout.emit('data', BANNER.slice(14)); // completes it -> RESOLVES

      expect(outputs(onOutput).join('')).toBe(`${BANNER}a warning\r\n`); // released; the replay suppressed

      // The history must be untouched by that stderr: the next idle cycle still dedupes.
      attach1._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach2._stdout.emit('data', BANNER);
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput).join('')).toBe(`${BANNER}a warning\r\n`); // still no banner reprint
    });

    it('given a fresh session that inherits a dead one\'s last words, does not poison its history with them', async () => {
      // The create path hands over the dead shell's last words — but those bytes are no
      // part of the NEW session's stream, so recording them would splice the anchor and
      // leave every later replay unmatchable: the banner would reprint forever.
      const cmd = buildFakeCommand();
      const freshCmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [], attachCmd });
      sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      cmd._stdout.emit('data', 'panic\r\n'); // drained; the create will flush it
      await vi.advanceTimersByTimeAsync(500);
      freshCmd._emitter.emit('message', announces('sess-2'));
      freshCmd._emitter.emit('spawn');
      freshCmd._stdout.emit('data', BANNER); // the new shell's own banner

      const afterCreate = outputs(onOutput).join('');
      expect(afterCreate).toContain('panic\r\n');

      // Now an ordinary idle watchdog cycle on the NEW session: it must still dedupe.
      sprite.listSessions.mockResolvedValue([{ id: 'sess-2', command: 'bash', isActive: true, tty: true }]);
      freshCmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', BANNER); // sess-2's replay
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput).join('')).toBe(afterCreate); // nothing reprinted
    });

    it('given a quiet gap shorter than the hard deadline, closes the window on the gap', async () => {
      // REPLAY_SETTLE_MS must work on its own: an unalignable replay that goes quiet is
      // released promptly, not held until the 1s deadline.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', 'unalignable\r\n');

      await vi.advanceTimersByTimeAsync(600); // past the 500ms gap, well short of the 1s deadline
      expect(outputs(onOutput).join('')).toContain('unalignable\r\n');
    });

    it('given stderr that floods past the queue cap while a replay is held, releases it rather than buffering without limit', async () => {
      // These are bytes the SANDBOX chose, queued on the process every terminal shares:
      // `replay.pending` is capped for that reason and so is this queue. Past the cap the
      // bytes are RELEASED, never dropped — ordering is what we give up, not output.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      // An unalignable replay is now HELD, so stderr queues behind it...
      attachCmd._stdout.emit('data', 'unalignable scrollback\r\n');
      const flood = 'e'.repeat(300 * 1024); // past MAX_HELD_SIDE_BYTES
      attachCmd._stderr.emit('data', flood);

      // ...but not without limit: past the cap it goes out at once, before the window closes.
      expect(outputs(onOutput).join('')).toContain(flood);
    });

    it('given an EMPTY stderr chunk, emits nothing', () => {
      const cmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('spawn');
      cmd._stderr.emit('data', '');

      expect(onOutput).not.toHaveBeenCalled();
    });

    it('given stderr arrives after the terminal is killed, does not deliver it', async () => {
      const cmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      const onOutput = vi.fn();

      const shell = openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('spawn');
      shell.kill();
      cmd._stderr.emit('data', 'too late\r\n');

      expect(onOutput).not.toHaveBeenCalled();
    });

    it('given stdout arrives as Buffers (the production shape), dedupes on bytes just the same', async () => {
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', Buffer.from(BANNER, 'utf8'));

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', Buffer.from(`${BANNER}ls\r\n`, 'utf8'));

      expect(outputs(onOutput)).toEqual([BANNER, 'ls\r\n']);
    });

    it('given a cold attach followed by a watchdog reconnect, dedupes the second replay against the first', async () => {
      // The realistic production sequence: a fresh viewer cold-attaches to a
      // persisted session (full scrollback), and 45s later the watchdog reattaches.
      // The anchor built from the FIRST replay is what must silence the second.
      const attach1 = buildFakeCommand();
      const attach2 = buildFakeCommand();
      const sprite = buildFakeSprite(buildFakeCommand(), { sessions: [liveSession] });
      sprite.attachSession.mockReturnValueOnce(attach1).mockReturnValueOnce(attach2);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, sessionId: 'sess-1', onOutput, onExit: vi.fn() });
      attach1._emitter.emit('spawn');
      attach1._stdout.emit('data', BANNER); // cold attach: full scrollback, once

      attach1._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach2._stdout.emit('data', BANNER); // watchdog attach: same bytes, silent

      expect(outputs(onOutput)).toEqual([BANNER]);
    });

    it('given the terminal is killed while replay bytes are buffered, emits nothing after the kill', async () => {
      // The viewer is gone; a settle timer left armed against a dead shell would
      // fire output at a socket nobody is listening on.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      const shell = openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', 'unalignable\r\n'); // buffered, settle armed
      shell.kill();
      // Nothing may reach a client that is no longer there. Two things stand in the way and
      // either would do: kill() cancels the window timers, and every path out of the shell
      // re-checks `closed`. The redundancy is deliberate — a teardown is not the place to
      // rely on a single guard.
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput)).toEqual([BANNER]);
    });

    it('given a chunk still in flight when the terminal is killed, does not deliver it', async () => {
      // Once the replay has resolved, chunks are delivered straight through — so a
      // chunk that lands after kill() would reach `onOutput`, i.e. `appendScrollback`
      // and a socket emit, for a session the caller has already torn down.
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();

      const shell = openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', BANNER); // the replay resolves; nothing emitted

      shell.kill();
      attachCmd._stdout.emit('data', 'in flight after the kill\r\n');
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput)).toEqual([BANNER]);
    });

    it('given a socket that dies holding a replay, flushes it THEN — not on a timer after its successor is live', async () => {
      // The error handler closes the window (and cancels its timers) before marking the
      // command stale. Without that, a DEAD command's settle timer fires ~500ms later — after
      // its successor has already snapshotted — and its verbatim flush restarts the SHARED
      // history behind the live command's back: a reprint, out of order, from a socket that
      // no longer exists.
      const cmd = buildFakeCommand();
      const attach1 = buildFakeCommand();
      const attach2 = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession] });
      sprite.attachSession.mockReturnValueOnce(attach1).mockReturnValueOnce(attach2);
      const onOutput = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit: vi.fn() });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attach1._emitter.emit('spawn');
      attach1._stdout.emit('data', 'held and unalignable\r\n'); // held by attach1's window
      attach1._emitter.emit('error', new Error('WebSocket keepalive timeout')); // dies holding it

      // Flushed by the error handler, at once — not by a timer belonging to a dead socket.
      expect(outputs(onOutput).join('')).toContain('held and unalignable\r\n');

      // And its successor's history is intact: an ordinary idle cycle still dedupes.
      await vi.advanceTimersByTimeAsync(500);
      const beforeReplay = outputs(onOutput).join('');
      attach2._stdout.emit('data', 'held and unalignable\r\n'); // the ring, replayed
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput).join('')).toBe(beforeReplay); // suppressed, not reprinted
    });

    it('given a shell that exits while replay bytes are still buffered, flushes them before the exit', async () => {
      const cmd = buildFakeCommand();
      const attachCmd = buildFakeCommand();
      const sprite = buildFakeSprite(cmd, { sessions: [liveSession], attachCmd });
      const onOutput = vi.fn();
      const onExit = vi.fn();

      openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });
      cmd._emitter.emit('message', announces('sess-1'));
      cmd._emitter.emit('spawn');
      cmd._stdout.emit('data', BANNER);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      attachCmd._stdout.emit('data', 'goodbye\r\n'); // unalignable, so buffered
      attachCmd._emitter.emit('exit', 0);

      expect(outputs(onOutput)).toEqual([BANNER, 'goodbye\r\n']);
      expect(onExit).toHaveBeenCalledWith(0);
    });
  });
});
