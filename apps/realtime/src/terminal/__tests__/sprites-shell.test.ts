import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { openPtyShell, planReconnect, sessionIds } from '../sprites-shell';
import { appendScrollback } from '../terminal-session-map';
import { spawnWithSelfHealingCwd } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';

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
    // recreated + entered by the wrapper, which then execs bash — see ensureCwdSession.
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

    it('given a CHATTY shell across the reconnect, emits within the replay window instead of stalling to the byte cap', async () => {
      // The quiet-gap timer alone is not a bound: a build or a repainting TUI
      // never goes quiet, so every chunk would re-arm it and the terminal would
      // sit dead all the way to MAX_PENDING_BYTES (1 MiB). The hard window is what
      // makes the worst case a redraw rather than a megabyte-long stall.
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
      // Every other shell test here uses a ~31-byte banner, i.e. `seen` smaller than
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
      const history = line('build step', 4000); // ~60 KiB, well past the 8 KiB anchor
      cmd._stdout.emit('data', history);

      cmd._emitter.emit('error', new Error('WebSocket keepalive timeout'));
      await vi.advanceTimersByTimeAsync(500);
      // The server replays its whole ring, then the shell prints one new line.
      attachCmd._stdout.emit('data', `${history}$ echo done\r\n`);
      await vi.advanceTimersByTimeAsync(2000);

      expect(outputs(onOutput)).toEqual([history, '$ echo done\r\n']);
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
      // The settle timer the kill cancelled must not fire output at a client that is
      // no longer there.
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
