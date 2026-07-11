/**
 * Cold-start survival of the FIRST real session-open (sprites 1-4).
 *
 * Deleting `ensureSpriteAwake` means the PTY's own `createSession` is now the
 * FIRST thing that touches a hibernated Sprite — and therefore the thing that
 * wakes it (docs.sprites.dev/concepts/lifecycle: there is no wake API; an
 * incoming request wakes the VM). Fly's wake-on-request can drop that first
 * connection while the VM boots, which the SDK surfaces as "closed before open".
 *
 * That drop used to land on the throwaway `sh -c :` exec, which absorbed it via
 * `withWakeRetry`. Now it lands on the real session-open, so `openPtyShell`'s
 * bounded reconnect budget is what must absorb it. These tests pin that: a
 * user opening a terminal on a sleeping Sprite sees a prompt, not `exit -1`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { openPtyShell } from '../sprites-shell';
import { isPreOpenWakeError } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type {
  SpriteInstanceLike,
  SpriteCommandLike,
  SpriteSessionInfo,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { assert } from './riteway';

/** The exact error @fly/sprites' WSCommand emits when the socket never opened. */
const PRE_OPEN_DROP = new Error('WebSocket closed before open: code=1006');

type FakeCommand = SpriteCommandLike & { _stdout: EventEmitter; _emitter: EventEmitter };

function buildFakeCommand(): FakeCommand {
  const _stdout = new EventEmitter();
  const _stderr = new EventEmitter();
  const _emitter = new EventEmitter();
  return {
    _stdout,
    _emitter,
    stdout: { on: (event, listener) => { _stdout.on(event, listener); return _stdout; } },
    stderr: { on: (event, listener) => { _stderr.on(event, listener); return _stderr; } },
    stdin: { write: vi.fn() },
    resize: vi.fn(),
    kill: vi.fn(),
    on: (event: string, listener: (...args: unknown[]) => void) => { _emitter.on(event, listener); return _emitter; },
  } as unknown as FakeCommand;
}

const liveSession: SpriteSessionInfo = { id: 'sess-1', command: 'bash', isActive: true, tty: true };

describe('cold session-open — the first real exec IS the wake', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('given the first session-open drops pre-open, should retry on the bounded backoff and deliver a working shell', async () => {
    const dropped = buildFakeCommand();
    const healthy = buildFakeCommand();

    const opened: string[] = [];
    const sprite = {
      name: 'cold-sprite',
      // The wake exec is GONE — any spawn here would be the `sh -c :` we deleted.
      spawn: vi.fn(),
      createSession: vi.fn(() => {
        opened.push('create');
        return opened.length === 1 ? dropped : healthy;
      }),
      attachSession: vi.fn(),
      // The cold VM reports no live sessions yet, so the reconnect plans a fresh create.
      listSessions: vi.fn(async () => []),
      filesystem: vi.fn(),
      updateNetworkPolicy: vi.fn(),
      destroy: vi.fn(),
    } as unknown as SpriteInstanceLike;

    const output: string[] = [];
    const exits: number[] = [];
    openPtyShell({
      sprite,
      cols: 80,
      rows: 24,
      onOutput: (data) => output.push(data),
      onExit: (code) => exits.push(code),
    });

    assert({
      given: 'the SDK error emitted when a cold VM drops the wake connection',
      should: 'be classified as a retryable pre-open drop',
      actual: isPreOpenWakeError(PRE_OPEN_DROP),
      expected: true,
    });

    // The cold VM drops the first session-open before it ever opened.
    dropped._emitter.emit('error', PRE_OPEN_DROP);
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    // The retried session-open lands on the now-awake VM and prints a prompt.
    healthy._stdout.emit('data', 'user@sprite:/workspace$ ');

    assert({
      given: 'a first session-open dropped pre-open by a cold VM',
      should: 'retry the session-open (bounded backoff) rather than tearing the terminal down',
      actual: { opens: opened.length, exits },
      expected: { opens: 2, exits: [] },
    });

    assert({
      given: 'the retried session-open',
      should: 'deliver the woken shell’s output to the viewer',
      actual: output.join(''),
      expected: 'user@sprite:/workspace$ ',
    });

    expect(sprite.spawn).not.toHaveBeenCalled(); // no `sh -c :` — the session-open IS the wake
  });

  it('given a Sprite that never wakes, should still surface an exit rather than retry forever', async () => {
    // The bound matters as much as the retry: an unbounded wake loop against a
    // genuinely dead Sprite would hang the terminal in "Connecting…" indefinitely.
    const cmds = Array.from({ length: 12 }, buildFakeCommand);
    let index = 0;

    const nextCommand = () => cmds[Math.min(index++, cmds.length - 1)];
    const sprite = {
      name: 'dead-sprite',
      spawn: vi.fn(),
      createSession: vi.fn(nextCommand),
      // Never reached: nothing is ever live on this Sprite, so every reconnect
      // plans a fresh create, never an attach.
      attachSession: vi.fn(),
      listSessions: vi.fn(async () => []),
      filesystem: vi.fn(),
      updateNetworkPolicy: vi.fn(),
      destroy: vi.fn(),
    } as unknown as SpriteInstanceLike;

    const exits: number[] = [];
    openPtyShell({
      sprite,
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      onExit: (code) => exits.push(code),
    });

    // Every session-open this Sprite hands back drops pre-open, forever.
    for (let i = 0; i < 10 && exits.length === 0; i += 1) {
      cmds[Math.min(i, cmds.length - 1)]._emitter.emit('error', PRE_OPEN_DROP);
      await vi.runOnlyPendingTimersAsync();
      await vi.runOnlyPendingTimersAsync();
    }

    expect(exits.length).toBe(1);
    assert({
      given: 'a Sprite whose session-open drops pre-open on every attempt',
      should: 'exhaust the bounded budget and surface an exit (never loop forever)',
      actual: exits,
      expected: [-1],
    });
  });
});
