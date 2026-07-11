import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createSpritesSandboxClient,
  ensureSpriteAwake,
  isSpriteNotFoundError,
  classifyProvisionError,
  readSessionInfoId,
  SandboxCommandTimeoutError,
  SandboxOutputLimitError,
  type SpritesSdk,
  type SpriteInstanceLike,
  type SpriteCommandLike,
  type SpriteFsLike,
} from '../sprites';
import { SandboxProvisionError } from '../../sandbox-options';
import { SANDBOX_EGRESS_ALLOWLIST } from '../../execution-policy';

const options = { egressAllowlist: SANDBOX_EGRESS_ALLOWLIST };

/**
 * riteway-style assertion (given/should/actual/expected) on top of vitest — the
 * repo doesn't vendor riteway, so keep the contract and drop the package.
 */
function assert<T>({ given, should, actual, expected }: { given: string; should: string; actual: T; expected: T }): void {
  it(`given ${given}, should ${should}`, () => {
    expect(actual).toEqual(expected);
  });
}


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
    createSession: () => fakeCommand({ stdout: ['out'], exitCode: 0 }),
    attachSession: () => fakeCommand({ stdout: ['out'], exitCode: 0 }),
    listSessions: async () => [],
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

describe('isSpriteNotFoundError', () => {
  it('treats 404 / 410 statuses and not-found codes/messages as a vanished Sprite', () => {
    expect(isSpriteNotFoundError(Object.assign(new Error(), { status: 404 }))).toBe(true);
    expect(isSpriteNotFoundError(Object.assign(new Error(), { statusCode: 410 }))).toBe(true);
    expect(isSpriteNotFoundError(Object.assign(new Error(), { code: 'NOT_FOUND' }))).toBe(true);
    expect(isSpriteNotFoundError(new Error('sprite not found'))).toBe(true);
    expect(isSpriteNotFoundError(new Error('gone'))).toBe(true);
  });

  it('does NOT treat auth / rate-limit / outage errors as a vanished Sprite', () => {
    expect(isSpriteNotFoundError(Object.assign(new Error(), { status: 401 }))).toBe(false);
    expect(isSpriteNotFoundError(Object.assign(new Error(), { status: 429 }))).toBe(false);
    expect(isSpriteNotFoundError(Object.assign(new Error(), { status: 503 }))).toBe(false);
    expect(isSpriteNotFoundError(new Error('connection reset'))).toBe(false);
    expect(isSpriteNotFoundError(null)).toBe(false);
    expect(isSpriteNotFoundError('not found')).toBe(false);
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

  it('given an existing Sprite, should RE-APPLY the egress lockdown on resume (crash-window guard)', async () => {
    const { sdk, calls } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    await client.getOrCreate({ name: 'k', options });
    // Reused Sprites default to open egress; the lockdown must be reapplied so a
    // Sprite created-but-not-yet-locked-down before a crash never runs open.
    expect(calls.policies).toBe(1);
    expect(calls.created).toEqual([]);
  });

  it('given a resume whose lockdown fails, should reject WITHOUT destroying the warm session', async () => {
    let destroyed: string | null = null;
    const sprite = fakeSprite({
      name: 'k',
      updateNetworkPolicy: async () => {
        throw new Error('policy api down');
      },
    });
    const sdk: SpritesSdk = {
      getSprite: async () => sprite,
      createSprite: async () => sprite,
      deleteSprite: async (name) => {
        destroyed = name;
      },
    };
    const client = createSpritesSandboxClient({ sdk });
    const error = await client.getOrCreate({ name: 'k', options }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(SandboxProvisionError);
    expect((error as SandboxProvisionError).kind).toBe('unavailable');
    expect(String((error as SandboxProvisionError).providerCause)).toContain('policy api down');
    expect(destroyed).toBeNull();
  });

  it('given a non-not-found getSprite error, should surface it rather than create a duplicate', async () => {
    const { sdk, calls } = makeSdk({
      getSprite: async () => {
        throw Object.assign(new Error('unauthorized'), { status: 401 });
      },
    });
    const client = createSpritesSandboxClient({ sdk });
    const error = await client.getOrCreate({ name: 'k', options }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(SandboxProvisionError);
    expect((error as SandboxProvisionError).kind).toBe('unavailable');
    expect(String((error as SandboxProvisionError).providerCause)).toContain('unauthorized');
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
    const error = await client.getOrCreate({ name: 'k', options }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(SandboxProvisionError);
    expect(String((error as SandboxProvisionError).providerCause)).toContain('policy api down');
    expect(destroyed).toBe('k');
  });
});

describe('classifyProvisionError', () => {
  it('maps a 429 / creation-rate-limit to rate_limited with a retry hint', () => {
    const err = classifyProvisionError(
      Object.assign(new Error('slow down'), {
        statusCode: 429,
        errorCode: 'sprite_creation_rate_limited',
        retryAfterSeconds: 12,
      }),
    );
    expect(err).toBeInstanceOf(SandboxProvisionError);
    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfterSeconds).toBe(12);
  });

  it('maps a concurrent-sprite-limit code to rate_limited', () => {
    const err = classifyProvisionError(
      Object.assign(new Error('too many'), { errorCode: 'concurrent_sprite_limit_exceeded' }),
    );
    expect(err.kind).toBe('rate_limited');
  });

  it('maps a 409 / "already exists" to conflict (delete-recreate race)', () => {
    expect(classifyProvisionError(Object.assign(new Error('x'), { status: 409 })).kind).toBe('conflict');
    expect(classifyProvisionError(new Error('sprite already exists')).kind).toBe('conflict');
  });

  it('maps anything else to unavailable and preserves the cause', () => {
    const cause = new Error('boom');
    const err = classifyProvisionError(cause);
    expect(err.kind).toBe('unavailable');
    expect(err.providerCause).toBe(cause);
  });

  it('returns an existing SandboxProvisionError unchanged', () => {
    const original = new SandboxProvisionError('rate_limited', 5, new Error('orig'));
    expect(classifyProvisionError(original)).toBe(original);
  });
});

describe('cold-start exec wake retry', () => {
  it('retries a pre-open "closed before open" failure on a fresh spawn, then succeeds', async () => {
    let attempts = 0;
    const sprite = fakeSprite({
      spawn: () => {
        attempts += 1;
        return attempts === 1
          ? fakeCommand({ error: new Error('WebSocket closed before open: code=1006 reason=none') })
          : fakeCommand({ stdout: ['ok'], exitCode: 0 });
      },
    });
    const { sdk } = makeSdk({ getSprite: async () => sprite });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    const result = await handle!.runCommand({ cmd: 'sh', args: ['-c', 'echo ok'] });
    expect(result).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    expect(attempts).toBe(2);
  });

  it('does NOT retry a post-open / non-wake error (may have already run)', async () => {
    let attempts = 0;
    const sprite = fakeSprite({
      spawn: () => {
        attempts += 1;
        return fakeCommand({ error: new Error('WebSocket keepalive timeout') });
      },
    });
    const { sdk } = makeSdk({ getSprite: async () => sprite });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    await expect(handle!.runCommand({ cmd: 'sh' })).rejects.toThrow('keepalive timeout');
    expect(attempts).toBe(1);
  });
});

describe('filesystem cold-start wake retry', () => {
  it('wakes the VM and retries a writeFile that fails on a cold VM', async () => {
    let writes = 0;
    let spawned = 0;
    const fs = fakeFs({
      writeFile: async () => {
        writes += 1;
        if (writes === 1) throw new Error('fetch failed');
      },
    });
    const sprite = fakeSprite({
      fs,
      spawn: () => {
        spawned += 1;
        return fakeCommand({ exitCode: 0 });
      },
    });
    const { sdk } = makeSdk({ getSprite: async () => sprite });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    await handle!.writeFiles([{ path: '/x', content: 'hi' }]);
    expect(writes).toBe(2); // failed once, retried after wake
    expect(spawned).toBe(1); // woke the VM via the exec path between attempts
  });

  it('readFile recovers on the wake retry', async () => {
    let reads = 0;
    const fs = fakeFs({
      readFile: async () => {
        reads += 1;
        if (reads === 1) throw new Error('fetch failed');
        return Buffer.from('recovered');
      },
    });
    const sprite = fakeSprite({ fs, spawn: () => fakeCommand({ exitCode: 0 }) });
    const { sdk } = makeSdk({ getSprite: async () => sprite });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    const buf = await handle!.readFileToBuffer({ path: '/x' });
    expect(buf?.toString()).toBe('recovered');
    expect(reads).toBe(2);
  });

  it('readFile resolves to null when the op still fails after a wake retry', async () => {
    const fs = fakeFs({
      readFile: async () => {
        throw new Error('fetch failed');
      },
    });
    const sprite = fakeSprite({ fs, spawn: () => fakeCommand({ exitCode: 0 }) });
    const { sdk } = makeSdk({ getSprite: async () => sprite });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    expect(await handle!.readFileToBuffer({ path: '/missing' })).toBeNull();
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

  it('given a non-not-found error, get should surface it rather than report the session vanished', async () => {
    const { sdk } = makeSdk({
      getSprite: async () => {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
    });
    const client = createSpritesSandboxClient({ sdk });
    await expect(client.get({ sandboxId: 'k' })).rejects.toThrow('rate limited');
  });

  it('stop should DESTROY the Sprite (no idle billing)', async () => {
    const { sdk, calls } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    await client.stop({ sandboxId: 'k' });
    expect(calls.deleted).toEqual(['k']);
  });

  it('get is a cheap reconnect — does NOT reapply egress (policy persists across hibernation)', async () => {
    let policies = 0;
    const sprite = fakeSprite({
      updateNetworkPolicy: async () => {
        policies += 1;
      },
    });
    const { sdk } = makeSdk({ getSprite: async () => sprite });
    const client = createSpritesSandboxClient({ sdk });
    await client.get({ sandboxId: 'k' });
    expect(policies).toBe(0);
  });
});

describe('ensureSpriteAwake', () => {
  it('warms the VM via a no-op exec, retrying the cold-start wake drop', async () => {
    let attempts = 0;
    const sprite = fakeSprite({
      spawn: () => {
        attempts += 1;
        return attempts === 1
          ? fakeCommand({ error: new Error('WebSocket closed before open: code=1006') })
          : fakeCommand({ exitCode: 0 });
      },
    });
    await ensureSpriteAwake(sprite);
    expect(attempts).toBe(2); // first wake dropped, retried, then awake
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

  it('given a cwd, should route through the self-healing sh wrapper with cwd/cmd/args as positional data args (no host shell string)', async () => {
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
      cmd: 'git',
      args: ['status', '--short'],
      cwd: '/workspace',
      env: { NODE_ENV: 'test' },
    });
    // The wrapper recreates + enters the cwd, then execs the real command. cwd/cmd/
    // args ride along as positional DATA args (never interpolated into the script),
    // so a deleted /workspace self-heals on the next command instead of bricking.
    // cwd is entered by the wrapper, NOT passed in spawn opts.
    expect(seen).toEqual({
      file: 'sh',
      args: [
        '-c',
        'mkdir -p "$1" 2>/dev/null; cd "$1" || exit 1; shift; exec "$@"',
        'sh',
        '/workspace',
        'git',
        'status',
        '--short',
      ],
      opts: { env: { NODE_ENV: 'test' } },
    });
  });

  it('given NO cwd, should spawn the command directly (structured file/args, no wrapper)', async () => {
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
      env: { NODE_ENV: 'test' },
    });
    expect(seen).toEqual({
      file: 'sh',
      args: ['-c', 'echo $(whoami)'],
      opts: { env: { NODE_ENV: 'test' } },
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


describe('readSessionInfoId (pure)', () => {
  assert({
    given: "the server's session_info frame for a freshly created exec session",
    should: 'return the authoritative session id it carries',
    actual: readSessionInfoId({ type: 'session_info', session_id: 'sess-authoritative', command: 'bash', tty: true }),
    expected: 'sess-authoritative',
  });

  assert({
    given: 'the EXACT frame captured from the live Sprites API on a create socket',
    should: 'return its session_id — pins the real wire shape, not an idealized one',
    // Recorded verbatim from api.sprites.dev while creating a tty session:
    //   {"type":"session_info","session_id":"20","command":"bash",
    //    "created":1783791670,"cols":0,"rows":0,"is_owner":true,"tty":true}
    // Note `is_owner: true` (we created it) and that the id is a SHORT NUMERIC
    // STRING — not a uuid. Nothing may assume its format.
    actual: readSessionInfoId({
      type: 'session_info',
      session_id: '20',
      command: 'bash',
      created: 1783791670,
      cols: 0,
      rows: 0,
      is_owner: true,
      tty: true,
    }),
    expected: '20',
  });

  assert({
    given: 'a non-session_info control frame (a port notification, a resize ack)',
    should: 'return undefined — only session_info names a session',
    actual: readSessionInfoId({ type: 'port_open', port: 3000, session_id: 'sess-1' }),
    expected: undefined,
  });

  assert({
    given: 'a session_info frame with no session_id',
    should: 'return undefined rather than an empty/garbage id',
    actual: readSessionInfoId({ type: 'session_info', command: 'bash' }),
    expected: undefined,
  });

  assert({
    given: 'a session_info frame whose session_id is an empty string',
    should: 'return undefined — an empty id is not attachable',
    actual: readSessionInfoId({ type: 'session_info', session_id: '' }),
    expected: undefined,
  });

  assert({
    given: 'a session_info frame whose session_id is not a string',
    should: 'return undefined (defensive against a shifting RC wire format)',
    actual: readSessionInfoId({ type: 'session_info', session_id: 42 }),
    expected: undefined,
  });

  assert({
    given: 'a raw non-JSON text frame the SDK passed through as a string',
    should: 'return undefined',
    actual: readSessionInfoId('some raw terminal text'),
    expected: undefined,
  });

  assert({
    given: 'a null message',
    should: 'return undefined',
    actual: readSessionInfoId(null),
    expected: undefined,
  });
});
