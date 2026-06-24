import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { openPtyShell } from '../sprites-shell';
import type { SpriteInstanceLike, SpriteCommandLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';

function buildFakeCommand(): SpriteCommandLike & { _stdout: EventEmitter; _stderr: EventEmitter; _emitter: EventEmitter } {
  const _stdout = new EventEmitter();
  const _stderr = new EventEmitter();
  const _emitter = new EventEmitter();
  const stdinWrite = vi.fn();
  const resizeFn = vi.fn();
  const killFn = vi.fn();

  const cmd: SpriteCommandLike & { _stdout: EventEmitter; _stderr: EventEmitter; _emitter: EventEmitter } = {
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

function buildFakeSprite(cmd: SpriteCommandLike): SpriteInstanceLike & { spawnCalls: { file: string; args: string[]; options: unknown }[] } {
  const spawnCalls: { file: string; args: string[]; options: unknown }[] = [];
  return {
    name: 'fake-sprite',
    spawnCalls,
    spawn: vi.fn((file, args = [], options = {}) => {
      spawnCalls.push({ file, args, options });
      return cmd;
    }),
    filesystem: vi.fn(),
    updateNetworkPolicy: vi.fn(),
    destroy: vi.fn(),
  } as unknown as SpriteInstanceLike & { spawnCalls: { file: string; args: string[]; options: unknown }[] };
}

describe('openPtyShell', () => {
  it('given a sprite and dimensions, should call spawn with bash + tty:true + correct dims', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);
    const onOutput = vi.fn();
    const onExit = vi.fn();

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });

    expect(sprite.spawn).toHaveBeenCalledWith('bash', [], { tty: true, cols: 80, rows: 24, cwd: '/workspace' });
  });

  it('given sprite emits stdout data, should call onOutput with the string', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);
    const onOutput = vi.fn();
    const onExit = vi.fn();

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });
    cmd._stdout.emit('data', 'hello\r\n');

    expect(onOutput).toHaveBeenCalledWith('hello\r\n');
  });

  it('given sprite emits stderr data, should call onOutput with the string', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);
    const onOutput = vi.fn();
    const onExit = vi.fn();

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });
    cmd._stderr.emit('data', Buffer.from('err msg'));

    expect(onOutput).toHaveBeenCalledWith('err msg');
  });

  it('given sprite emits exit, should call onExit with the exit code', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);
    const onOutput = vi.fn();
    const onExit = vi.fn();

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });
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

  it('given sprite emits an error event, should call onOutput with error text and onExit with -1', () => {
    const cmd = buildFakeCommand();
    const sprite = buildFakeSprite(cmd);
    const onOutput = vi.fn();
    const onExit = vi.fn();

    openPtyShell({ sprite, cols: 80, rows: 24, onOutput, onExit });
    cmd._emitter.emit('error', new Error('connection lost'));

    expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
    expect(onExit).toHaveBeenCalledWith(-1);
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
});
