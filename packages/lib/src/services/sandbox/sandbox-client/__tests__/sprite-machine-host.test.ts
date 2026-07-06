import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSpriteMachineHost } from '../sprite-machine-host';
import { createSpritesSandboxClient, type SpriteCommandLike, type SpriteInstanceLike, type SpritesSdk } from '../sprites';
import { SANDBOX_EGRESS_ALLOWLIST } from '../../execution-policy';

const options = { egressAllowlist: SANDBOX_EGRESS_ALLOWLIST };

/**
 * A fake `SpriteCommand` with explicit emit hooks for stdout/stderr, plus an
 * auto-exit(0) on the next macrotask by default (mirroring sprites.test.ts's
 * fakeCommand) — every `provision()` call in this suite drives the REAL
 * `applyEgressLockdown`, which spawns its own `mkdir` command via the fake
 * Sprite, so the default must resolve on its own or provisioning hangs.
 */
function fakeCommand(over: Partial<SpriteCommandLike> & { autoExit?: boolean } = {}) {
  const { autoExit = true, ...commandOver } = over;
  const events = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const killed: string[] = [];
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
    const { command, emitStdout, emitStderr } = fakeCommand();
    const created: { command: string; args: string[] }[] = [];
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          createSession: (cmd, args) => {
            created.push({ command: cmd, args: args ?? [] });
            return command;
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

    expect(created[0]?.command).toBe('bash');
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

  it('given listStreams, should surface only tty sessions from the underlying Sprite', async () => {
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

  it('given a MachineStream, should write/resize/kill through to the underlying command', async () => {
    const writes: unknown[] = [];
    const resizes: Array<[number, number]> = [];
    const { command } = fakeCommand({
      stdin: { write: (data) => writes.push(data) },
      resize: (c, r) => resizes.push([c, r]),
    });
    const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ createSession: () => command }) });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const stream = await handle.stream({});
    stream.write('ls\n');
    stream.resize(100, 40);
    stream.kill('SIGKILL');

    expect(writes).toEqual(['ls\n']);
    expect(resizes).toEqual([[100, 40]]);
    expect((command as unknown as { killed: string[] }).killed).toEqual(['SIGKILL']);
  });

  it('given a MachineStream with no stdin (batch command reused as a stream), should throw on write rather than silently drop input', async () => {
    const { command } = fakeCommand({ stdin: undefined });
    const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ createSession: () => command }) });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteMachineHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const stream = await handle.stream({});
    expect(() => stream.write('x')).toThrow(/not interactive/);
  });
});
