import { describe, it, expect } from 'vitest';
import {
  createSpritesSandboxClient,
  buildSpriteConfig,
  SandboxCommandTimeoutError,
  type SpritesSdk,
  type SpriteInstanceLike,
  type SpriteFsLike,
} from '../sprites';
import { mapPolicyToSandboxOptions } from '../../sandbox-options';
import { resolveExecutionPolicy } from '../../execution-policy';

const options = mapPolicyToSandboxOptions({ policy: resolveExecutionPolicy() });

function fakeFs(over: Partial<SpriteFsLike> = {}): SpriteFsLike {
  return {
    readFile: async () => Buffer.from('contents'),
    writeFile: async () => {},
    mkdir: async () => {},
    ...over,
  };
}

function fakeSprite(over: Partial<SpriteInstanceLike> & { fs?: SpriteFsLike } = {}): SpriteInstanceLike {
  const fs = over.fs ?? fakeFs();
  return {
    name: 'session-key',
    execFile: async () => ({ exitCode: 0, stdout: 'out', stderr: '' }),
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
  it('given policy options, should map RAM, CPUs, and region from the policy', () => {
    expect(buildSpriteConfig({ options })).toEqual({
      ramMB: options.memoryMb,
      cpus: options.vcpus,
      region: options.region,
    });
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
        fakeSprite({ execFile: async () => ({ exitCode: 0, stdout: Buffer.from('hi'), stderr: '' }) }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    const result = await handle!.runCommand({ cmd: 'sh', args: ['-c', 'echo hi'] });
    expect(result).toEqual({ exitCode: 0, stdout: 'hi', stderr: '' });
  });

  it('given a non-zero exit thrown as ExecError, should return it as a result (not throw)', async () => {
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          execFile: async () => {
            throw { result: { exitCode: 2, stdout: 'partial', stderr: 'boom' } };
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    const result = await handle!.runCommand({ cmd: 'false' });
    expect(result).toEqual({ exitCode: 2, stdout: 'partial', stderr: 'boom' });
  });

  it('given an ExecError with the exit output flattened on the error, should return it as a result', async () => {
    // The real SDK ExecError also exposes exitCode/stdout/stderr directly on the
    // error (not only under .result); the driver must surface that shape too.
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          execFile: async () => {
            const error = Object.assign(new Error('Command failed with exit code 3'), {
              exitCode: 3,
              stdout: 'flat-out',
              stderr: 'flat-err',
            });
            throw error;
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    const result = await handle!.runCommand({ cmd: 'sh', args: ['-c', 'exit 3'] });
    expect(result).toEqual({ exitCode: 3, stdout: 'flat-out', stderr: 'flat-err' });
  });

  it('given a command that exceeds the timeout, should reject and DESTROY the Sprite (teardown on timeout)', async () => {
    let destroyed = false;
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          execFile: () => new Promise(() => {}), // never resolves
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
    // Give the fire-and-forget destroy a tick to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(destroyed).toBe(true);
  });

  it('given a transport error (no result), should rethrow', async () => {
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          execFile: async () => {
            throw new Error('websocket closed');
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    await expect(handle!.runCommand({ cmd: 'sh' })).rejects.toThrow('websocket closed');
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
