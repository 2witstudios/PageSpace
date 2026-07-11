import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSpriteMachineHost } from '../sprite-machine-host';
import { MachineStreamOpenTimeoutError } from '../../machine-host';
import {
  createSpritesSandboxClient,
  spawnWithSelfHealingCwd,
  type SpriteCommandLike,
  type SpriteInstanceLike,
  type SpritesSdk,
} from '../sprites';
import { SANDBOX_EGRESS_ALLOWLIST } from '../../execution-policy';
import { SANDBOX_ROOT } from '../../sandbox-paths';

const options = { egressAllowlist: SANDBOX_EGRESS_ALLOWLIST };

/**
 * A fake `SpriteCommand` with explicit emit hooks for stdout/stderr, plus an
 * auto-exit(0) on the next macrotask by default (mirroring sprites.test.ts's
 * fakeCommand) — every `provision()` call in this suite drives the REAL
 * `applyEgressLockdown`, which spawns its own `mkdir` command via the fake
 * Sprite, so the default must resolve on its own or provisioning hangs.
 *
 * `autoSpawn` mirrors the real SDK's WSCommand, which emits `spawn` once the
 * WebSocket actually opens (`cmd.start().then(() => cmd.emit('spawn'))`). That
 * is the signal `stream()` waits on before handing a stream back, so a fake that
 * never emitted it would model a socket that never opens.
 */
function fakeCommand(
  over: Partial<SpriteCommandLike> & { autoExit?: boolean; autoSpawn?: boolean; error?: Error } = {},
) {
  const { autoExit = true, autoSpawn = true, error, ...commandOver } = over;
  const events = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const killed: string[] = [];
  if (error) {
    // A failed/flapping connection emits 'error' and never 'spawn'.
    setTimeout(() => events.emit('error', error), 0);
  }
  if (autoSpawn) {
    // One-shot, exactly like the real SDK's `cmd.start().then(() => cmd.emit('spawn'))`.
    // Deliberately NOT replayed to a late subscriber: the consumer under test must
    // register its listener synchronously, before this macrotask runs, and a fake
    // that replayed the event would hide a regression that stopped doing so.
    setTimeout(() => events.emit('spawn'), 0);
  }
  if (autoExit) {
    setTimeout(() => events.emit('exit', 0), 0);
  }
  const command: SpriteCommandLike & { killed: string[] } = {
    stdout: { on: (event, listener) => stdout.on(event, listener) },
    stderr: { on: (event, listener) => stderr.on(event, listener) },
    stdin: { write: () => {} },
    on: (event, listener) => events.on(event, listener as (...args: unknown[]) => void),
    kill: (signal) => {
      killed.push(signal ?? 'SIGTERM');
    },
    resize: () => {},
    killed,
    ...commandOver,
  };
  return {
    command,
    emitStdout: (chunk: string) => stdout.emit('data', chunk),
    emitStderr: (chunk: string) => stderr.emit('data', chunk),
    emitExit: (code: number) => events.emit('exit', code),
  };
}

function fakeSprite(over: Partial<SpriteInstanceLike> = {}): SpriteInstanceLike {
  return {
    name: 'session-key',
    spawn: () => fakeCommand().command,
    createSession: () => fakeCommand({ autoExit: false }).command,
    attachSession: () => fakeCommand({ autoExit: false }).command,
    listSessions: async () => [],
    filesystem: () => ({ readFile: async () => Buffer.from(''), writeFile: async () => {}, mkdir: async () => {} }),
    updateNetworkPolicy: async () => {},
    destroy: async () => {},
    ...over,
  };
}

function makeSdk(over: Partial<SpritesSdk> = {}) {
  const calls = { getSprite: 0, created: [] as string[], deleted: [] as string[] };
  const sprite = fakeSprite();
  const sdk: SpritesSdk = {
    getSprite: async () => {
      calls.getSprite += 1;
      return sprite;
    },
    createSprite: async (name) => {
      calls.created.push(name);
      return sprite;
    },
    deleteSprite: async (name) => {
      calls.deleted.push(name);
    },
    ...over,
  };
  return { sdk, calls, sprite };
}

describe('createSpriteMachineHost', () => {
  it('given provision, should re-express the underlying ExecSandboxClient.getOrCreate — same machineId, provisioning untouched', async () => {
    const { sdk } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });

    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });
    expect(handle.machineId).toBe('session-key');
  });

  it('given a machine with a declared size, should provision identically — Sprite has no differentiated tier', async () => {
    const { sdk } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });

    const small = await host.provision({ name: 'k', substrate: { kind: 'sprite', size: 'small' }, options });
    const beefy = await host.provision({ name: 'k', substrate: { kind: 'sprite', size: 'beefy' }, options });
    expect(beefy.machineId).toBe(small.machineId);
  });

  it('given exec, should delegate to the wrapped ExecutableSandbox.runCommand', async () => {
    // `spawn` is also used internally by provisioning's egress-lockdown `mkdir` —
    // a fresh auto-exiting fake per call so neither spawn starves the other.
    const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ spawn: () => fakeCommand().command }) });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });

    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });
    const result = await handle.exec({ cmd: 'echo', args: ['hi'] });
    expect(result.exitCode).toBe(0);
  });

  it('given writeFiles/readFile, should delegate to the wrapped ExecutableSandbox', async () => {
    const fs = {
      readFile: async () => Buffer.from('contents'),
      writeFile: async () => {},
      mkdir: async () => {},
    };
    const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ filesystem: () => fs }) });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });

    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });
    await handle.writeFiles([{ path: '/a', content: 'x' }]);
    const buf = await handle.readFile({ path: '/a' });
    expect(buf?.toString('utf8')).toBe('contents');
  });

  it('given attach to a live machine, should return a handle addressing the same machineId', async () => {
    const { sdk } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });

    const handle = await host.attach({ machineId: 'session-key' });
    expect(handle?.machineId).toBe('session-key');
  });

  it('given attach to a vanished machine, should return null', async () => {
    const { sdk } = makeSdk({
      getSprite: async () => {
        throw Object.assign(new Error('not found'), { status: 404 });
      },
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });

    const handle = await host.attach({ machineId: 'gone' });
    expect(handle).toBeNull();
  });

  it('given kill, should delegate to the wrapped ExecSandboxClient.stop (destroy, not checkpoint)', async () => {
    const { sdk, calls } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });

    await host.kill({ machineId: 'session-key' });
    expect(calls.deleted).toEqual(['session-key']);
  });

  it('given stream with no sessionId, should create a fresh interactive session and stream its combined stdout/stderr', async () => {
    // Built LAZILY, inside createSession — exactly when the real SDK builds it, so
    // its one-shot 'spawn' cannot fire before `stream()` has attached its listener.
    let emitStdout!: (chunk: string) => void;
    let emitStderr!: (chunk: string) => void;
    const created: { command: string; args: string[] }[] = [];
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          createSession: (cmd, args) => {
            created.push({ command: cmd, args: args ?? [] });
            const fake = fakeCommand({ autoExit: false });
            emitStdout = fake.emitStdout;
            emitStderr = fake.emitStderr;
            return fake.command;
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const chunks: string[] = [];
    const stream = await handle.stream({ cols: 80, rows: 24 });
    stream.onData((chunk) => chunks.push(chunk.toString('utf8')));

    emitStdout('out-chunk');
    emitStderr('err-chunk');

    // The session is spawned through the self-healing-cwd wrapper (the server
    // chdirs into cwd and fails the open if a sandbox command deleted it), which
    // recreates + enters SANDBOX_ROOT and then execs the real command.
    expect([created[0]?.command, created[0]?.args]).toEqual(
      spawnWithSelfHealingCwd({ command: 'bash', args: [], cwd: SANDBOX_ROOT }),
    );
    expect(chunks).toEqual(['out-chunk', 'err-chunk']);
  });

  it('given stream with a sessionId, should reattach instead of creating a fresh session', async () => {
    let attachedId: string | null = null;
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          attachSession: (id) => {
            attachedId = id;
            return fakeCommand().command;
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    await handle.stream({ sessionId: 'existing-session' });
    expect(attachedId).toBe('existing-session');
  });

  // Regression (sprites 1-4): the PTY stream is the ONLY exec path that had no
  // cold-start retry. `killAgentTerminal` attaches a stream and immediately
  // SIGKILLs it, so once the explicit wake exec was removed, a hibernated Sprite
  // could drop that first (waking) connection pre-open and the kill would fail
  // outright — leaving a live PTY and its tracking row behind.
  it('given a cold Sprite that drops the first stream attach pre-open, should retry and still deliver a killable stream', async () => {
    let attempts = 0;
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          attachSession: () => {
            attempts += 1;
            if (attempts === 1) {
              // The cold VM drops the wake connection before it ever opens.
              return fakeCommand({
                autoExit: false,
                autoSpawn: false,
                error: new Error('WebSocket closed before open: code=1006'),
              }).command;
            }
            return fakeCommand({ autoExit: false }).command;
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const stream = await handle.stream({ sessionId: 'existing-session' });
    stream.kill('SIGKILL');

    expect(attempts).toBe(2); // first attach dropped pre-open, retried onto the woken VM
  });

  it('given every attach attempt drops pre-open, should give up on the bounded schedule rather than retry forever', async () => {
    let attempts = 0;
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          attachSession: () => {
            attempts += 1;
            return fakeCommand({
              autoExit: false,
              autoSpawn: false,
              error: new Error('WebSocket error: TypeError (url: wss://sprite/exec/dead)'),
            }).command;
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    await expect(handle.stream({ sessionId: 'dead' })).rejects.toThrow();
    expect(attempts).toBe(3); // MAX_EXEC_ATTEMPTS — bounded, not infinite
  });

  it('given the socket OPENS, should hand back the stream — a later error belongs to the consumer, not the retry', async () => {
    let attempts = 0;
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          attachSession: () => {
            attempts += 1;
            return fakeCommand({ autoExit: false }).command; // emits spawn
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const stream = await handle.stream({ sessionId: 'live' });
    stream.kill('SIGKILL');
    expect(attempts).toBe(1);
  });

  // The PRODUCER of the timeout. Without this, a regression to the old
  // "resolve optimistically at the cap" behavior would pass every other test in
  // the suite — and silently hand killAtLocation a stream whose socket never
  // opened, whose SIGKILL goes nowhere, and whose row it would then delete.
  it('given a stream that never reports whether it opened, should reject with MachineStreamOpenTimeoutError (never resolve optimistically)', async () => {
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          // Reports NOTHING: no spawn, no exit, no error. A socket in limbo.
          attachSession: () => fakeCommand({ autoExit: false, autoSpawn: false }).command,
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    // Inject a short cap rather than faking timers: provisioning's own egress
    // `mkdir` needs real timers to settle, so a global fake-timer swap here would
    // deadlock the setup instead of testing the wait.
    const host = createSpriteMachineHost({ sdk, client, streamOpenTimeoutMs: 20 });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    await expect(handle.stream({ sessionId: 'sess-limbo' })).rejects.toBeInstanceOf(MachineStreamOpenTimeoutError);
  });

  it('given listStreams, should exclude sessions the SDK reports as non-tty', async () => {
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          listSessions: async () => [
            { id: 's1', command: 'bash', isActive: true, tty: true },
            { id: 's2', command: 'node script.js', isActive: true, tty: false },
          ],
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const streams = await handle.listStreams();
    expect(streams).toEqual([{ id: 's1', command: 'bash', isActive: true }]);
  });

  it('given an SDK that does not report `tty` at all, should still surface the sessions (fail open, not empty)', async () => {
    // The published 0.0.1 @fly/sprites build drops `tty` from its listSessions
    // mapping even though the raw API returns it. A truthy filter would hide
    // EVERY stream — a machine full of live terminals would look empty. Keeping
    // sessions of unknown mode costs at most a stray row.
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          listSessions: async () => [
            { id: 's1', command: '/usr/bin/bash', isActive: true },
            { id: 's2', command: '/usr/bin/bash', isActive: false },
          ],
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const streams = await handle.listStreams();
    expect(streams).toEqual([
      { id: 's1', command: '/usr/bin/bash', isActive: true },
      { id: 's2', command: '/usr/bin/bash', isActive: false },
    ]);
  });

  it('given a MachineStream, should write/resize/kill through to the underlying command', async () => {
    const writes: unknown[] = [];
    const resizes: Array<[number, number]> = [];
    let killed: string[] = [];
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          createSession: () => {
            const fake = fakeCommand({
              autoExit: false,
              stdin: { write: (data) => writes.push(data) },
              resize: (c, r) => resizes.push([c, r]),
            });
            killed = (fake.command as unknown as { killed: string[] }).killed;
            return fake.command;
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const stream = await handle.stream({});
    stream.write('ls\n');
    stream.resize(100, 40);
    stream.kill('SIGKILL');

    expect(writes).toEqual(['ls\n']);
    expect(resizes).toEqual([[100, 40]]);
    expect(killed).toEqual(['SIGKILL']);
  });

  it('given a MachineStream with no stdin (batch command reused as a stream), should throw on write rather than silently drop input', async () => {
    const { sdk } = makeSdk({
      getSprite: async () => fakeSprite({ createSession: () => fakeCommand({ autoExit: false, stdin: undefined }).command }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const stream = await handle.stream({});
    expect(() => stream.write('x')).toThrow(/not interactive/);
  });
});
