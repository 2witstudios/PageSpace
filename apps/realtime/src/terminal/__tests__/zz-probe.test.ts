import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { openPtyShell } from '../sprites-shell';
import type { SpriteInstanceLike, SpriteCommandLike, SpriteSessionInfo } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';

type FakeCommand = SpriteCommandLike & { _stdout: EventEmitter; _stderr: EventEmitter; _emitter: EventEmitter };

function buildFakeCommand(): FakeCommand {
  const _stdout = new EventEmitter();
  const _stderr = new EventEmitter();
  const _emitter = new EventEmitter();
  const cmd: FakeCommand = {
    _stdout, _stderr, _emitter,
    stdout: { on: (e, l) => { _stdout.on(e, l); return _stdout; } },
    stderr: { on: (e, l) => { _stderr.on(e, l); return _stderr; } },
    stdin: { write: vi.fn() },
    resize: vi.fn(),
    kill: vi.fn(),
    on: (e: string, l: (...a: unknown[]) => void) => { _emitter.on(e, l); return _emitter; },
  } as unknown as FakeCommand;
  return cmd;
}

const liveSession: SpriteSessionInfo = { id: 'sess-1', command: 'bash', isActive: true, tty: true };
const announces = (id: string) => ({ type: 'session_info', session_id: id, command: 'bash', tty: true });
const BANNER = 'Welcome to the sandbox\r\n$ ';

describe('probe', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reattach dies before replaying, next reconnect creates fresh', async () => {
    const cmd = buildFakeCommand();
    const attachCmd = buildFakeCommand();
    const freshCmd = buildFakeCommand();
    const sprite = {
      name: 'f', spawn: vi.fn(),
      createSession: vi.fn(() => cmd),
      attachSession: vi.fn(() => attachCmd),
      listSessions: vi.fn(async () => [liveSession] as SpriteSessionInfo[]),
      filesystem: vi.fn(), updateNetworkPolicy: vi.fn(), destroy: vi.fn(),
    } as unknown as SpriteInstanceLike & { createSession: ReturnType<typeof vi.fn>; attachSession: ReturnType<typeof vi.fn>; listSessions: ReturnType<typeof vi.fn> };
    sprite.createSession.mockReturnValueOnce(cmd).mockReturnValueOnce(freshCmd);
    const shown: string[] = [];
    openPtyShell({ sprite, cols: 80, rows: 24, onOutput: (d) => { if (d.includes('panic')) console.log('EMIT panic via:', new Error().stack); shown.push(d); }, onExit: vi.fn() });
    cmd._emitter.emit('message', announces('sess-1'));
    cmd._emitter.emit('spawn');
    cmd._stdout.emit('data', BANNER);

    cmd._emitter.emit('error', new Error('keepalive'));
    await vi.advanceTimersByTimeAsync(500);
    console.log('attachSession calls:', sprite.attachSession.mock.calls.length, 'createSession calls:', sprite.createSession.mock.calls.length);
    cmd._stdout.emit('data', 'panic: goodbye\r\n');
    console.log('after drain, shown =', JSON.stringify(shown));

    sprite.listSessions.mockResolvedValue([]);
    attachCmd._emitter.emit('spawn');
    attachCmd._emitter.emit('error', new Error('keepalive'));
    await vi.advanceTimersByTimeAsync(1000);
    console.log('final shown =', JSON.stringify(shown));
    expect(shown.join('')).toContain('panic: goodbye');
  });
});
