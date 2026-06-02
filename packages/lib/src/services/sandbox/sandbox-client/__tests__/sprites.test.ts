import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createSpritesSandboxClient,
  buildSpriteConfig,
  SandboxCommandTimeoutError,
  SandboxOutputLimitError,
  type SpritesSdk,
  type SpriteInstanceLike,
  type SpriteCommandLike,
  type SpriteFsLike,
} from '../sprites';
import { mapPolicyToSandboxOptions } from '../../sandbox-options';
import { resolveExecutionPolicy } from '../../execution-policy';

const options = mapPolicyToSandboxOptions({ policy: resolveExecutionPolicy() });

/**
 * A fake `SpriteCommand` mirroring the SDK shape the driver consumes: stdout /
 * stderr `data` events, an `exit`/`error` event, and a recording `kill`. Output
 * and the terminating event are emitted on a macrotask so the driver attaches
 * its listeners (synchronously, inside the run Promise) before anything fires.
 * `kill` only records the signal — like the real command, it sends a signal and
 * does NOT synchronously resolve the run (exit, if any, arrives separately).
 */
interface FakeCommandSpec {
  stdout?: (Buffer | string)[];
  stderr?: (Buffer | string)[];
  exitCode?: number;
  error?: Error;
  hang?: boolean;
}

function fakeCommand(spec: FakeCommandSpec = {}): SpriteCommandLike & { killed: string[] } {
  const events = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const killed: string[] = [];

  setTimeout(() => {
    for (const chunk of spec.stdout ?? []) stdout.emit('data', chunk);
    for (const chunk of spec.stderr ?? []) stderr.emit('data', chunk);
    if (spec.error) {
      events.emit('error', spec.error);
      return;
    }
    if (spec.hang) return;
    events.emit('exit', spec.exitCode ?? 0);
  }, 0);

  return {
    stdout: { on: (event, listener) => stdout.on(event, listener) },
    stderr: { on: (event, listener) => stderr.on(event, listener) },
    on: (event, listener) => events.on(event, listener as (...args: unknown[]) => void),
    kill: (signal) => {
      killed.push(signal ?? 'SIGTERM');
    },
    killed,
  };
}

function fakeFs(over: Partial<SpriteFsLike> = {}): SpriteFsLike {
  return {
    readFile: async () => Buffer.from('contents'),
    writeFile: async () => {},
    mkdir: async () => {},
    ...over,
  };
}

function fakeSprite(
  over: Partial<SpriteInstanceLike> & { fs?: SpriteFsLike } = {},
): SpriteInstanceLike {
  const fs = over.fs ?? fakeFs();
  return {
    name: 'session-key',
    spawn: () => fakeCommand({ stdout: ['out'], exitCode: 0 }),
    filesystem: () => fs,
    updateNetworkPolicy: async () => {},
    destroy: async () => {},
    ...over,
  };
}

function makeSdk(over: Partial<SpritesSdk> = {}) {
  const calls = { created: [] as string[], deleted: [] as string[], policies: 0 };
  const sprite = fakeSprite({ updateNetworkPolicy: async () => { calls.policies += 1; } });
  const sdk: SpritesSdk = {
    getSprite: async () => sprite,
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

describe('buildSpriteConfig', () => {
  it('given policy options, should map RAM, CPUs, storage, and region from the policy', () => {
    expect(buildSpriteConfig({ options })).toEqual({
      ramMB: options.memoryMb,
      cpus: options.vcpus,
      region: options.region,
      storageGB: options.storageGb,
    });
  });

  it('should set an explicit storage cap (not the platform/quota default)', () => {
    expect(buildSpriteConfig({ options }).storageGB).toBe(options.storageGb);
    expect(buildSpriteConfig({ options }).storageGB).toBeGreaterThan(0);
  });

  it('should map the Fly region (iad, not iad1)', () => {
    expect(buildSpriteConfig({ options }).region).toBe('iad');
  });
});

describe('createSpritesSandboxClient.getOrCreate', () => {
  it('given an existing Sprite, should resume it by name without creating', async () => {
    const { sdk, calls } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.getOrCreate({ name: 'k', options });
    expect(handle.sandboxId).toBe('session-key');
    expect(calls.created).toEqual([]);
  });

  it('given no existing Sprite, should create fresh and apply the egress lockdown', async () => {
    const { sdk, calls } = makeSdk({
      getSprite: async () => {
        throw new Error('not found');
      },
    });
    const client = createSpritesSandboxClient({ sdk });
    await client.getOrCreate({ name: 'k', options });
    expect(calls.created).toEqual(['k']);
    expect(calls.policies).toBe(1);
  });

  it('given the egress lockdown fails, should destroy the Sprite and reject (never hand back open egress)', async () => {
    let destroyed: string | null = null;
    const sprite = fakeSprite({
      name: 'k',
      updateNetworkPolicy: async () => {
        throw new Error('policy api down');
      },
    });
    const sdk: SpritesSdk = {
      getSprite: async () => {
        throw new Error('not found');
      },
      createSprite: async () => sprite,
      deleteSprite: async (name) => {
        destroyed = name;
      },
    };
    const client = createSpritesSandboxClient({ sdk });
    await expect(client.getOrCreate({ name: 'k', options })).rejects.toThrow('policy api down');
    expect(destroyed).toBe('k');
  });
});

describe('createSpritesSandboxClient.get / stop', () => {
  it('given a vanished Sprite, should resolve get to null rather than throwing', async () => {
    const { sdk } = makeSdk({
      getSprite: async () => {
        throw new Error('gone');
      },
    });
    const client = createSpritesSandboxClient({ sdk });
    expect(await client.get({ sandboxId: 'gone' })).toBeNull();
  });

  it('stop should DESTROY the Sprite (no idle billing)', async () => {
    const { sdk, calls } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    await client.stop({ sandboxId: 'k' });
    expect(calls.deleted).toEqual(['k']);
  });
});

describe('ExecutableSandbox.runCommand', () => {
  it('given a zero exit, should surface exitCode/stdout/stderr as strings', async () => {
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({ spawn: () => fakeCommand({ stdout: [Buffer.from('hi')], exitCode: 0 }) }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    const result = await handle!.runCommand({ cmd: 'sh', args: ['-c', 'echo hi'] });
    expect(result).toEqual({ exitCode: 0, stdout: 'hi', stderr: '' });
  });

  it('given a non-zero exit, should resolve it as a result (not throw)', async () => {
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          spawn: () => fakeCommand({ stdout: ['partial'], stderr: ['boom'], exitCode: 2 }),
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    const result = await handle!.runCommand({ cmd: 'false' });
    expect(result).toEqual({ exitCode: 2, stdout: 'partial', stderr: 'boom' });
  });

  it('given a SIGKILL (137) exit, should resolve it as a result the runner can flag as a timeout', async () => {
    const { sdk } = makeSdk({
      getSprite: async () => fakeSprite({ spawn: () => fakeCommand({ exitCode: 137 }) }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    expect(await handle!.runCommand({ cmd: 'sh' })).toEqual({ exitCode: 137, stdout: '', stderr: '' });
  });

  it('given a non-terminating command, should SIGKILL the command and reject with a timeout (not destroy the Sprite)', async () => {
    let destroyed = false;
    const command = fakeCommand({ hang: true });
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          spawn: () => command,
          destroy: async () => {
            destroyed = true;
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    await expect(
      handle!.runCommand({ cmd: 'sleep', args: ['999'], timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(SandboxCommandTimeoutError);
    // The COMMAND is SIGKILLed; the warm Sprite session is preserved.
    expect(command.killed).toContain('SIGKILL');
    expect(destroyed).toBe(false);
  });

  it('given output exceeding the byte cap, should SIGKILL the command and reject with an output-limit error', async () => {
    const command = fakeCommand({ stdout: ['x'.repeat(50)], hang: true });
    const { sdk } = makeSdk({
      getSprite: async () => fakeSprite({ spawn: () => command }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    await expect(
      handle!.runCommand({ cmd: 'cat', args: ['big'], maxBytes: 10 }),
    ).rejects.toBeInstanceOf(SandboxOutputLimitError);
    expect(command.killed).toContain('SIGKILL');
  });

  it('given a transport error (no exit), should rethrow', async () => {
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({ spawn: () => fakeCommand({ error: new Error('websocket closed') }) }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    await expect(handle!.runCommand({ cmd: 'sh' })).rejects.toThrow('websocket closed');
  });

  it('should spawn with a structured (file, args[]) form and the policy cwd/env (no host shell string)', async () => {
    let seen: { file: string; args?: string[]; opts?: { cwd?: string; env?: Record<string, string> } } | null = null;
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          spawn: (file, args, opts) => {
            seen = { file, args, opts };
            return fakeCommand({ exitCode: 0 });
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    await handle!.runCommand({
      cmd: 'sh',
      args: ['-c', 'echo $(whoami)'],
      cwd: '/workspace',
      env: { NODE_ENV: 'test' },
    });
    expect(seen).toEqual({
      file: 'sh',
      args: ['-c', 'echo $(whoami)'],
      opts: { cwd: '/workspace', env: { NODE_ENV: 'test' } },
    });
  });
});

describe('ExecutableSandbox file ops', () => {
  it('writeFiles should write each entry through the Sprite filesystem', async () => {
    const written: { path: string; data: string | Buffer }[] = [];
    const fs = fakeFs({ writeFile: async (path, data) => { written.push({ path, data }); } });
    const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ fs }) });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    await handle!.writeFiles([{ path: '/workspace/a.txt', content: 'hi' }]);
    expect(written).toEqual([{ path: '/workspace/a.txt', data: 'hi' }]);
  });

  it('readFileToBuffer should return the buffer, or null when the read fails', async () => {
    const present = fakeFs({ readFile: async () => Buffer.from('data') });
    const { sdk: sdkOk } = makeSdk({ getSprite: async () => fakeSprite({ fs: present }) });
    const ok = await createSpritesSandboxClient({ sdk: sdkOk }).get({ sandboxId: 'k' });
    expect((await ok!.readFileToBuffer({ path: '/workspace/a.txt' }))?.toString()).toBe('data');

    const missing = fakeFs({ readFile: async () => { throw new Error('ENOENT'); } });
    const { sdk: sdkMissing } = makeSdk({ getSprite: async () => fakeSprite({ fs: missing }) });
    const miss = await createSpritesSandboxClient({ sdk: sdkMissing }).get({ sandboxId: 'k' });
    expect(await miss!.readFileToBuffer({ path: '/workspace/missing.txt' })).toBeNull();
  });
});
