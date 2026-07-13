import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createSpritesSandboxClient,
  isSpriteNotFoundError,
  classifyProvisionError,
  planProvisionFailure,
  readSessionInfoId,
  checkpointStreamErrorMessage,
  killSpriteSession,
  killSessionStreamErrorMessage,
  withKillSession,
  SandboxCommandTimeoutError,
  SandboxOutputLimitError,
  type SpritesSdk,
  type SpriteInstanceLike,
  type SpriteCommandLike,
  type SpriteFsLike,
  type SpriteCheckpointStreamLike,
} from '../sprites';
import { SandboxProvisionError } from '../../sandbox-options';
import { SANDBOX_EGRESS_ALLOWLIST } from '../../execution-policy';
import { hashSandboxEgressPolicy, egressLockdownToken } from '../../egress-lockdown';
import { SANDBOX_ROOT } from '../../sandbox-paths';
import { parentDir, fsRecoveryExec, spawnWithSelfHealingCwd } from '../sprites';

const options = { egressAllowlist: SANDBOX_EGRESS_ALLOWLIST };

/** The token the driver proves for a given Sprite instance under `options`. */
const tokenFor = (spriteId: string) =>
  egressLockdownToken({ spriteId, policyHash: hashSandboxEgressPolicy(options) });

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
  /**
   * Whether the socket OPENED — i.e. whether the SDK emitted `spawn`
   * (`cmd.start().then(() => cmd.emit('spawn'))`). This is the real boundary the
   * wake retry keys on: an error before `spawn` never ran the command and is safe
   * to re-run; one after it may have. Defaults to "opened" for a command that
   * runs, and "never opened" for one that only errors (the cold-start drop).
   */
  opened?: boolean;
}

function fakeCommand(spec: FakeCommandSpec = {}): SpriteCommandLike & { killed: string[] } {
  const events = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const killed: string[] = [];

  const opened = spec.opened ?? spec.error === undefined;
  setTimeout(() => {
    if (opened) events.emit('spawn');
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

/**
 * A fake checkpoint stream: replays `messages` through `processAll`, in
 * order. `processAll` never resolves when `hang: true` (simulates a stalled
 * SDK stream); `close` is a spy so a test can assert it was called on
 * timeout.
 */
function fakeCheckpointStream(
  messages: Array<{ type: string; data?: string; error?: string }> = [{ type: 'info', data: 'done' }],
  options: { hang?: boolean } = {},
): SpriteCheckpointStreamLike & { close: ReturnType<typeof vi.fn> } {
  return {
    processAll: async (handler) => {
      if (options.hang) {
        await new Promise(() => {}); // never resolves
      }
      for (const message of messages) {
        await handler(message);
      }
    },
    close: vi.fn(),
  };
}

function fakeSprite(
  over: Partial<SpriteInstanceLike> & { fs?: SpriteFsLike } = {},
): SpriteInstanceLike {
  const fs = over.fs ?? fakeFs();
  return {
    name: 'session-key',
    // The platform's instance id, hydrated by getSprite/createSprite. A Sprite
    // re-created under the same name gets a NEW one — which is what the egress
    // record is keyed on.
    id: 'sprite-1',
    spawn: () => fakeCommand({ stdout: ['out'], exitCode: 0 }),
    createSession: () => fakeCommand({ stdout: ['out'], exitCode: 0 }),
    attachSession: () => fakeCommand({ stdout: ['out'], exitCode: 0 }),
    listSessions: async () => [],
    filesystem: () => fs,
    updateNetworkPolicy: async () => {},
    createCheckpoint: async () => fakeCheckpointStream(),
    destroy: async () => {},
    killSession: async () => {},
    ...over,
  };
}

function makeSdk(over: Partial<SpritesSdk> = {}) {
  const calls = { created: [] as string[], deleted: [] as string[], policies: 0, spawned: [] as string[] };
  const sprite = fakeSprite({
    updateNetworkPolicy: async () => { calls.policies += 1; },
    spawn: (file, args = []) => {
      calls.spawned.push([file, ...args].join(' '));
      return fakeCommand({ exitCode: 0 });
    },
  });
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

describe('parentDir (pure)', () => {
  assert({
    given: 'a nested path',
    should: 'return its directory',
    actual: parentDir('/workspace/notes/a.txt'),
    expected: '/workspace/notes',
  });

  assert({
    given: 'a path directly under the root',
    should: 'return the root',
    actual: parentDir('/a.txt'),
    expected: '/',
  });

  assert({
    given: 'a bare filename with no separator',
    should: 'return the root rather than an empty directory',
    actual: parentDir('a.txt'),
    expected: '/',
  });

  assert({
    given: 'a Windows-style separator (this is a path INSIDE the Linux VM)',
    should: 'treat it as an ordinary filename character — POSIX semantics regardless of host OS',
    actual: parentDir('C:\\workspace\\a.txt'),
    expected: '/',
  });
});

describe('fsRecoveryExec (pure)', () => {
  assert({
    given: 'no directories to ensure',
    should: 'be a bare no-op exec whose only job is to wake the VM',
    actual: fsRecoveryExec(),
    expected: ['sh', ['-c', ':']],
  });

  assert({
    given: 'directories to ensure',
    should: 'wake the VM AND mkdir -p them in the same exec',
    actual: fsRecoveryExec(['/workspace/a', '/workspace/b']),
    expected: ['sh', ['-c', 'mkdir -p "$@" 2>/dev/null || :', 'sh', '/workspace/a', '/workspace/b']],
  });

  assert({
    given: 'a directory containing shell metacharacters',
    should: 'keep it a positional arg, so it can never be evaluated as script',
    actual: fsRecoveryExec(['/workspace/$(touch pwned)'])[1],
    expected: ['-c', 'mkdir -p "$@" 2>/dev/null || :', 'sh', '/workspace/$(touch pwned)'],
  });
});

describe('spawnWithSelfHealingCwd (pure)', () => {
  assert({
    given: 'a command, its args, and a cwd',
    should: 'wrap them in an sh that recreates + enters the cwd, then execs the command',
    actual: spawnWithSelfHealingCwd({ command: 'bash', args: [], cwd: SANDBOX_ROOT }),
    expected: [
      'sh',
      ['-c', 'mkdir -p "$1" 2>/dev/null; cd "$1" || exit 1; shift; exec "$@"', 'sh', SANDBOX_ROOT, 'bash'],
    ],
  });

  assert({
    given: 'a cwd containing shell metacharacters',
    should: 'keep it a positional arg (the arg-array no-injection invariant holds)',
    actual: spawnWithSelfHealingCwd({ command: 'bash', args: [], cwd: '/workspace; rm -rf /' })[1].slice(2),
    expected: ['sh', '/workspace; rm -rf /', 'bash'],
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

  it('given a resume with NO recorded policy hash, should apply the lockdown (fail closed)', async () => {
    const { sdk, calls } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    await client.getOrCreate({ name: 'k', options });
    // Unknown egress state (a session predating the record, or a lost write): the
    // Sprite is never handed back without a confirmed policy.
    expect(calls.policies).toBe(1);
    expect(calls.created).toEqual([]);
  });

  it('given a warm resume of the SAME VM whose token still holds, should apply NEITHER the policy NOR the mkdir', async () => {
    const { sdk, calls } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    await client.getOrCreate({ name: 'k', options, appliedEgressToken: tokenFor('sprite-1') });
    // The policy file (/.sprite/policy/network.json) and the sandbox root are both
    // persistent — re-pushing them on a warm hand-back is pure chatter on the
    // connect critical path.
    expect(calls.policies).toBe(0);
    expect(calls.spawned).toEqual([]);
    expect(calls.created).toEqual([]);
  });

  it('given a resume whose recorded policy is stale, should re-apply the policy once', async () => {
    const { sdk, calls } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    // e.g. the egress mode changed since this Sprite was locked down.
    await client.getOrCreate({
      name: 'k',
      options,
      appliedEgressToken: egressLockdownToken({
        spriteId: 'sprite-1',
        policyHash: hashSandboxEgressPolicy({ ...options, egressMode: 'open' }),
      }),
    });
    expect(calls.policies).toBe(1);
    expect(calls.spawned).toEqual([`mkdir -p ${SANDBOX_ROOT}`]);
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

  it('given no existing Sprite, should create fresh and apply the lockdown + sandbox root exactly once', async () => {
    const { sdk, calls } = makeSdk({
      getSprite: async () => {
        throw new Error('not found');
      },
    });
    const client = createSpritesSandboxClient({ sdk });
    await client.getOrCreate({ name: 'k', options });
    expect(calls.created).toEqual(['k']);
    expect(calls.policies).toBe(1);
    expect(calls.spawned).toEqual([`mkdir -p ${SANDBOX_ROOT}`]);
  });

  it('given a fresh create with a matching recorded hash, should STILL apply the lockdown', async () => {
    const { sdk, calls } = makeSdk({
      getSprite: async () => {
        throw new Error('not found');
      },
    });
    const client = createSpritesSandboxClient({ sdk });
    // A recycled name: the recorded token describes the DESTROYED Sprite. The new
    // one starts on the platform default (open outbound), so it must be locked down.
    await client.getOrCreate({ name: 'k', options, appliedEgressToken: tokenFor('sprite-1') });
    expect(calls.created).toEqual(['k']);
    expect(calls.policies).toBe(1);
  });

  it('given the Sprite was RE-CREATED under the same name (concurrent recreate), should lock it down even though the policy is unchanged', async () => {
    // The race: this session's Sprite vanished; a CONCURRENT getOrCreate created
    // the replacement (id sprite-2) and has not yet reached its own lockdown. We
    // find that new VM by name — so `fresh` is false — and our recorded token
    // names the DEAD Sprite (sprite-1) under the very same policy. Trusting the
    // policy hash alone would skip the push and hand back a VM still on the
    // platform's default OPEN egress. Binding the token to the instance id is what
    // makes this case indistinguishable from any other unproven VM: we apply.
    const calls = { policies: 0, created: [] as string[] };
    const replacement = fakeSprite({
      id: 'sprite-2',
      updateNetworkPolicy: async () => { calls.policies += 1; },
    });
    const sdk: SpritesSdk = {
      getSprite: async () => replacement,
      createSprite: async (name) => { calls.created.push(name); return replacement; },
      deleteSprite: async () => {},
    };
    const client = createSpritesSandboxClient({ sdk });

    const handle = await client.getOrCreate({ name: 'k', options, appliedEgressToken: tokenFor('sprite-1') });

    expect(calls.policies).toBe(1);
    expect(calls.created).toEqual([]);
    // And the token it hands back names the VM it actually locked down.
    expect(handle.egressPolicyToken).toBe(tokenFor('sprite-2'));
  });

  it('given a platform that reports no Sprite id, should apply the policy and record NO token (fail closed)', async () => {
    let policies = 0;
    const anonymous = fakeSprite({
      id: undefined,
      updateNetworkPolicy: async () => { policies += 1; },
    });
    const sdk: SpritesSdk = {
      getSprite: async () => anonymous,
      createSprite: async () => anonymous,
      deleteSprite: async () => {},
    };
    const client = createSpritesSandboxClient({ sdk });

    // Identity unknown → the lockdown cannot be proven for THIS VM, so it is
    // applied, and nothing is recorded that a later connect could wrongly trust.
    const handle = await client.getOrCreate({ name: 'k', options, appliedEgressToken: tokenFor('sprite-1') });

    expect(policies).toBe(1);
    expect(handle.egressPolicyToken).toBeUndefined();
  });

  it('given a FRESH create whose lockdown fails ONCE (transient flake), should retry inline against the SAME Sprite and succeed without destroying it', async () => {
    let destroyed: string | null = null;
    let policyCalls = 0;
    const sprite = fakeSprite({
      name: 'k',
      updateNetworkPolicy: async () => {
        policyCalls += 1;
        if (policyCalls === 1) throw new Error('policy api down');
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
    // Real backoff would be fine (a couple hundred ms), but injecting a no-op
    // sleep keeps this test instant.
    const client = createSpritesSandboxClient({ sdk, sleep: async () => {} });
    const handle = await client.getOrCreate({ name: 'k', options });
    // A cold-start flake must never throw away a reusable VM: it retries the
    // SAME Sprite inline (within this one acquire) and hands it back.
    expect(handle.sandboxId).toBe('k');
    expect(policyCalls).toBe(2);
    expect(destroyed).toBeNull();
  });

  it('given a FRESH create whose mkdir fails but whose policy already landed, should retry ONLY the mkdir — never re-push an already-confirmed policy', async () => {
    let policyCalls = 0;
    let mkdirAttempts = 0;
    const sprite = fakeSprite({
      name: 'k',
      updateNetworkPolicy: async () => {
        policyCalls += 1;
      },
      spawn: () => {
        mkdirAttempts += 1;
        // A POST-open failure (opened: true) so the inner exec-level wake retry
        // does NOT swallow it — it must propagate out to applyEgressLockdown's
        // own OUTER retry loop, which is what this test exercises.
        return mkdirAttempts === 1
          ? fakeCommand({ opened: true, error: new Error('mkdir transport dropped mid-command') })
          : fakeCommand({ exitCode: 0 });
      },
    });
    const sdk: SpritesSdk = {
      getSprite: async () => {
        throw new Error('not found');
      },
      createSprite: async () => sprite,
      deleteSprite: async () => {},
    };
    const client = createSpritesSandboxClient({ sdk, sleep: async () => {} });
    const handle = await client.getOrCreate({ name: 'k', options });
    expect(handle.sandboxId).toBe('k');
    // The policy call succeeded on its very first (and only) attempt — a later
    // retry of the failed mkdir step must not re-push it.
    expect(policyCalls).toBe(1);
  });

  it('given a FRESH create whose lockdown fails PERSISTENTLY, should exhaust its bounded retry budget and THEN destroy it (never poisoned forever)', async () => {
    let destroyed: string | null = null;
    let policyCalls = 0;
    const sprite = fakeSprite({
      name: 'k',
      updateNetworkPolicy: async () => {
        policyCalls += 1;
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
    const client = createSpritesSandboxClient({ sdk, sleep: async () => {} });
    const error = await client.getOrCreate({ name: 'k', options }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(SandboxProvisionError);
    expect(String((error as SandboxProvisionError).providerCause)).toContain('policy api down');
    // A genuinely broken fresh VM must not poison the session key forever with
    // no persisted row to act on: it gets every bounded attempt, then is
    // destroyed so the next acquire provisions a clean replacement.
    expect(policyCalls).toBe(3);
    expect(destroyed).toBe('k');
  });

  it('given a fresh Sprite destroyed after exhausting its retry budget, the next acquire under the same name should provision a clean replacement and succeed', async () => {
    let created = 0;
    let policyCalls = 0;
    let spriteExists = false;
    const deleted: string[] = [];
    const makeSprite = () =>
      fakeSprite({
        name: 'k',
        updateNetworkPolicy: async () => {
          policyCalls += 1;
          // Only the FIRST Sprite instance is broken; its replacement works.
          if (created === 1) throw new Error('policy api down');
        },
      });
    const sdk: SpritesSdk = {
      getSprite: async () => {
        if (!spriteExists) throw new Error('not found');
        return makeSprite();
      },
      createSprite: async (name) => {
        created += 1;
        spriteExists = true;
        return makeSprite();
      },
      deleteSprite: async (name) => {
        deleted.push(name);
        spriteExists = false;
      },
    };
    const client = createSpritesSandboxClient({ sdk, sleep: async () => {} });

    // First acquire: fresh create, lockdown persistently fails, exhausted and destroyed.
    const firstError = await client.getOrCreate({ name: 'k', options }).then(() => null, (e) => e);
    expect(firstError).toBeInstanceOf(SandboxProvisionError);
    expect(created).toBe(1);
    expect(deleted).toEqual(['k']);

    // Second acquire, same name: the broken Sprite is gone, so this is a genuine
    // fresh create of a NEW (working) instance.
    const handle = await client.getOrCreate({ name: 'k', options });
    expect(handle.sandboxId).toBe('k');
    expect(created).toBe(2);
    expect(deleted).toEqual(['k']); // never re-destroyed
  });
});

describe('planProvisionFailure (pure)', () => {
  assert({
    given: 'a fresh Sprite failing its first lockdown attempt',
    should: 'retain the VM and refuse the hand-back rather than destroy a reusable Sprite',
    actual: planProvisionFailure({ fresh: true, attempt: 1, maxAttempts: 3 }),
    expected: 'retain-and-refuse',
  });

  assert({
    given: 'a fresh Sprite still short of its attempt ceiling',
    should: 'keep retaining it',
    actual: planProvisionFailure({ fresh: true, attempt: 2, maxAttempts: 3 }),
    expected: 'retain-and-refuse',
  });

  assert({
    given: 'a fresh Sprite that has exhausted every allotted attempt',
    should: 'treat it as genuinely unusable and destroy it',
    actual: planProvisionFailure({ fresh: true, attempt: 3, maxAttempts: 3 }),
    expected: 'destroy',
  });

  assert({
    given: 'a fresh Sprite past its ceiling',
    should: 'still destroy — never loop forever provisioning against a broken VM',
    actual: planProvisionFailure({ fresh: true, attempt: 5, maxAttempts: 3 }),
    expected: 'destroy',
  });

  assert({
    given: 'a RESUMED Sprite (not fresh) failing its lockdown, no matter the attempt count',
    should: 'never destroy a warm session this caller does not own the lifecycle of',
    actual: planProvisionFailure({ fresh: false, attempt: 10, maxAttempts: 3 }),
    expected: 'retain-and-refuse',
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

  // The regression that matters most: @fly/sprites has NO `ws` dependency — it
  // drives the global (undici) WebSocket, and registers its `error` listener
  // BEFORE its `close` listener. On a failed handshake undici fires `error` first,
  // so the FIRST thing a consumer sees is an opaque `WebSocket error: …` — NOT the
  // `WebSocket closed before open: …` string, which the SDK only emits afterwards
  // from its `close` handler. A retry keyed on that substring would therefore MISS
  // the real cold-start drop entirely. We classify structurally instead: no
  // `spawn` yet => the socket never opened => safe to re-run.
  it('given the REAL undici pre-open error shape (opaque message, no "closed before open"), should still retry', async () => {
    let attempts = 0;
    const sprite = fakeSprite({
      spawn: () => {
        attempts += 1;
        return attempts === 1
          ? fakeCommand({
              opened: false,
              error: new Error('WebSocket error: TypeError (url: wss://sprite/exec?stdin=true)'),
            })
          : fakeCommand({ stdout: ['ok'], exitCode: 0 });
      },
    });
    const { sdk } = makeSdk({ getSprite: async () => sprite });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });

    const result = await handle!.runCommand({ cmd: 'sh' });

    expect(result.exitCode).toBe(0);
    expect(attempts).toBe(2); // dropped pre-open, retried onto the woken VM
  });

  it('does NOT retry a post-open / non-wake error (may have already run)', async () => {
    let attempts = 0;
    const sprite = fakeSprite({
      spawn: () => {
        attempts += 1;
        // A keepalive timeout happens AFTER the socket opened — so the fake must
        // emit `spawn` first, as the real SDK does. That is exactly what makes it
        // a non-retryable, post-open failure.
        return fakeCommand({ opened: true, error: new Error('WebSocket keepalive timeout') });
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

  it('recreates the parent directory when a write fails because SANDBOX_ROOT was deleted', async () => {
    // The fs API does not create parents, and a sandbox command can `rm -rf
    // /workspace`. The egress lockdown's mkdir used to paper over that on every
    // hand-back; now it is fresh-create-only, so the write must self-heal — and
    // it does so inside the exec it was already paying for to wake the VM.
    const dirs = new Set<string>(['/']);
    const spawned: string[][] = [];
    const fs = fakeFs({
      writeFile: async (path) => {
        if (!dirs.has(parentDir(path))) throw new Error('ENOENT: no such file or directory');
      },
    });
    const sprite = fakeSprite({
      fs,
      spawn: (file, args = []) => {
        spawned.push([file, ...args]);
        // The recovery exec IS the mkdir -p: replay it against the fake fs.
        for (const dir of args.slice(3)) dirs.add(dir);
        return fakeCommand({ exitCode: 0 });
      },
    });
    const { sdk } = makeSdk({ getSprite: async () => sprite });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });

    await handle!.writeFiles([{ path: `${SANDBOX_ROOT}/notes/a.txt`, content: 'hi' }]);

    expect(spawned).toEqual([
      ['sh', '-c', 'mkdir -p "$@" 2>/dev/null || :', 'sh', `${SANDBOX_ROOT}/notes`],
    ]);
    expect(dirs.has(`${SANDBOX_ROOT}/notes`)).toBe(true);
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

describe('filesystem wake exec (the ONLY path that still needs one)', () => {
  // The fs HTTP API is a bare fetch() that does NOT wake a hibernated VM — it just
  // hangs. So, unlike an exec/createSession/attachSession (which ARE the wake), an
  // fs op must be preceded by an exec before it can be retried. This is the one
  // place the retired `ensureSpriteAwake` behavior survives.
  it('given a cold fs op, should issue a wake exec before retrying it', async () => {
    const spawned: string[][] = [];
    let reads = 0;
    const fs = fakeFs({
      readFile: async () => {
        reads += 1;
        if (reads === 1) throw new Error('fetch failed');
        return Buffer.from('recovered');
      },
    });
    const sprite = fakeSprite({
      fs,
      spawn: (file, args) => {
        spawned.push([file, ...(args ?? [])]);
        return fakeCommand({ exitCode: 0 });
      },
    });
    const { sdk } = makeSdk({ getSprite: async () => sprite });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });

    const buf = await handle!.readFileToBuffer({ path: '/x' });

    expect(buf?.toString()).toBe('recovered');
    expect(reads).toBe(2);
    expect(spawned).toEqual([['sh', '-c', ':']]); // the wake exec the fs API can't do itself
  });

  it('given a cold fs op whose wake exec drops pre-open, should retry the wake on the bounded backoff', async () => {
    let wakeAttempts = 0;
    let reads = 0;
    const fs = fakeFs({
      readFile: async () => {
        reads += 1;
        if (reads === 1) throw new Error('fetch failed');
        return Buffer.from('recovered');
      },
    });
    const sprite = fakeSprite({
      fs,
      spawn: () => {
        wakeAttempts += 1;
        return wakeAttempts === 1
          ? fakeCommand({ error: new Error('WebSocket closed before open: code=1006') })
          : fakeCommand({ exitCode: 0 });
      },
    });
    const { sdk } = makeSdk({ getSprite: async () => sprite });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });

    expect((await handle!.readFileToBuffer({ path: '/x' }))?.toString()).toBe('recovered');
    expect(wakeAttempts).toBe(2); // first wake dropped pre-open, retried, then awake
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

describe('checkpointStreamErrorMessage (pure)', () => {
  assert({
    given: 'a non-error stream message',
    should: 'return undefined',
    actual: checkpointStreamErrorMessage({ type: 'info', data: 'snapshotting' }),
    expected: undefined,
  });

  assert({
    given: 'an error-type message carrying `error`',
    should: 'return that error text',
    actual: checkpointStreamErrorMessage({ type: 'error', error: 'disk full' }),
    expected: 'disk full',
  });

  assert({
    given: 'an error-type message with no `error` field but a `data` field',
    should: 'fall back to `data`',
    actual: checkpointStreamErrorMessage({ type: 'error', data: 'boom' }),
    expected: 'boom',
  });

  assert({
    given: 'an error-type message with neither `error` nor `data`',
    should: 'fall back to a generic message',
    actual: checkpointStreamErrorMessage({ type: 'error' }),
    expected: 'checkpoint stream reported an error',
  });
});

describe('ExecutableSandbox.createCheckpoint', () => {
  it('calls the SDK with the given comment and drains the stream to completion', async () => {
    const seenComments: (string | undefined)[] = [];
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          createCheckpoint: async (comment) => {
            seenComments.push(comment);
            return fakeCheckpointStream([{ type: 'info', data: 'snapshotting' }, { type: 'info', data: 'done' }]);
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    await handle!.createCheckpoint('pagespace-pre-agent-turn-1');
    expect(seenComments).toEqual(['pagespace-pre-agent-turn-1']);
  });

  it('rejects when the stream reports an error message', async () => {
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          createCheckpoint: async () => fakeCheckpointStream([{ type: 'error', error: 'quota exceeded' }]),
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    await expect(handle!.createCheckpoint('c')).rejects.toThrow(/quota exceeded/);
  });

  it('propagates the SDK\'s rejection (caller decides fail-open policy)', async () => {
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          createCheckpoint: async () => {
            throw new Error('sprite unreachable');
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const handle = await client.get({ sandboxId: 'k' });
    await expect(handle!.createCheckpoint('c')).rejects.toThrow('sprite unreachable');
  });

  // Regression test for a P2 finding on PR #2025 (chatgpt-codex-connector): the
  // SDK exposes no timeout for createCheckpoint or the stream it returns, so a
  // stalled connection would otherwise hang this call — and therefore the
  // caller's whole fail-open checkpoint attempt (tool-runners.ts) — forever.
  it('given a stream that never settles, rejects after CHECKPOINT_TIMEOUT_MS and closes the stream', async () => {
    vi.useFakeTimers();
    try {
      const hungStream = fakeCheckpointStream(undefined, { hang: true });
      const { sdk } = makeSdk({
        getSprite: async () => fakeSprite({ createCheckpoint: async () => hungStream }),
      });
      const client = createSpritesSandboxClient({ sdk });
      const handle = await client.get({ sandboxId: 'k' });

      const result = handle!.createCheckpoint('c');
      const assertion = expect(result).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;

      expect(hungStream.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('given the SDK call itself never resolves (before any stream is returned), rejects after the timeout without attempting to close a stream', async () => {
    vi.useFakeTimers();
    try {
      const { sdk } = makeSdk({
        getSprite: async () =>
          fakeSprite({
            createCheckpoint: () => new Promise(() => {}), // never resolves
          }),
      });
      const client = createSpritesSandboxClient({ sdk });
      const handle = await client.get({ sandboxId: 'k' });

      const result = handle!.createCheckpoint('c');
      const assertion = expect(result).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
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

describe('killSessionStreamErrorMessage (pure)', () => {
  assert({
    given: 'a signal event',
    should: 'return undefined — not a failure',
    actual: killSessionStreamErrorMessage('{"type":"signal","message":"delivering SIGTERM","signal":"SIGTERM","pid":123}'),
    expected: undefined,
  });

  assert({
    given: 'an exited event',
    should: 'return undefined — not a failure',
    actual: killSessionStreamErrorMessage('{"type":"exited","message":"process exited"}'),
    expected: undefined,
  });

  assert({
    given: 'a complete event',
    should: 'return undefined — not a failure',
    actual: killSessionStreamErrorMessage('{"type":"complete","exit_code":0}'),
    expected: undefined,
  });

  assert({
    given: 'an error event with a message',
    should: 'return that message',
    actual: killSessionStreamErrorMessage('{"type":"error","message":"signal delivery failed"}'),
    expected: 'signal delivery failed',
  });

  assert({
    given: 'an error event with no message field',
    should: 'return a generic fallback rather than undefined',
    actual: killSessionStreamErrorMessage('{"type":"error"}'),
    expected: 'session kill reported an error',
  });

  assert({
    given: 'a blank line (the trailing newline of an NDJSON body)',
    should: 'return undefined',
    actual: killSessionStreamErrorMessage('   '),
    expected: undefined,
  });

  assert({
    given: 'an unparseable line',
    should: 'return undefined rather than fail a kill that otherwise succeeded',
    actual: killSessionStreamErrorMessage('not json'),
    expected: undefined,
  });
});

describe('killSpriteSession', () => {
  const transport = { baseURL: 'https://api.sprites.dev', token: 'test-token' };
  // A fast, no-op sleep — keeps the retry-path tests from paying real backoff wall-clock time.
  const noSleep = async () => {};

  it('given a live session, POSTs the exact kill URL (no "sessions/" segment — sprites.dev/api/sprites/exec#kill-exec-session) with a bearer token', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await killSpriteSession({ ...transport, fetchImpl }, 'my-sprite', 'sess-1');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.sprites.dev/v1/sprites/my-sprite/exec/sess-1/kill',
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer test-token' } }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry needed on the happy path
  });

  it('given a sprite name or session id with reserved URL characters, encodes them', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await killSpriteSession({ ...transport, fetchImpl }, 'my/sprite', 'sess/1');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.sprites.dev/v1/sprites/my%2Fsprite/exec/sess%2F1/kill',
      expect.anything(),
    );
  });

  it('given a 200 whose NDJSON stream reports only progress (signal -> exited -> complete), resolves — the whole point of draining it', async () => {
    const ndjson = [
      '{"type":"signal","message":"delivering SIGTERM","signal":"SIGTERM","pid":123}',
      '{"type":"exited","message":"process exited"}',
      '{"type":"complete","exit_code":0}',
      '',
    ].join('\n');
    const fetchImpl = vi.fn(async () => new Response(ndjson, { status: 200 }));

    await expect(killSpriteSession({ ...transport, fetchImpl }, 'my-sprite', 'sess-1')).resolves.toBeUndefined();
  });

  it('given a 200 whose NDJSON stream reports an error line, rejects (after exhausting retries) — a 200 status alone does not confirm the signal was delivered', async () => {
    const ndjson = [
      '{"type":"signal","message":"delivering SIGTERM","signal":"SIGTERM","pid":123}',
      '{"type":"error","message":"process would not die"}',
    ].join('\n');
    const fetchImpl = vi.fn(async () => new Response(ndjson, { status: 200 }));

    await expect(
      killSpriteSession({ ...transport, fetchImpl, sleep: noSleep }, 'my-sprite', 'sess-1'),
    ).rejects.toThrow(/process would not die/);
  });

  it('given the Sprite reports 404 (session already gone — the documented response for a missing session), resolves successfully — idempotent', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404, statusText: 'Not Found' }));

    await expect(killSpriteSession({ ...transport, fetchImpl }, 'my-sprite', 'sess-dead')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 404 is success, not a failure — no retry
  });

  it('given the Sprite reports 410 (gone), resolves successfully — idempotent', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 410, statusText: 'Gone' }));

    await expect(killSpriteSession({ ...transport, fetchImpl }, 'my-sprite', 'sess-dead')).resolves.toBeUndefined();
  });

  it('given a genuine failure (5xx/auth) that persists across every attempt, rejects rather than swallowing it', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500, statusText: 'Internal Server Error' }));

    await expect(
      killSpriteSession({ ...transport, fetchImpl, sleep: noSleep }, 'my-sprite', 'sess-1'),
    ).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // MAX_EXEC_ATTEMPTS — bounded, not infinite
  });

  it('given a transient failure (e.g. a cold-Sprite wake drop) that succeeds on a later attempt, resolves — retry is safe because kill is idempotent', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('WebSocket error: TypeError (cold wake)'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      killSpriteSession({ ...transport, fetchImpl, sleep: noSleep }, 'my-sprite', 'sess-1'),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('given every attempt fails with a thrown (non-HTTP) error, retries up to the bound and then rejects with that error', async () => {
    const networkError = new Error('fetch failed: ECONNRESET');
    const fetchImpl = vi.fn().mockRejectedValue(networkError);

    await expect(
      killSpriteSession({ ...transport, fetchImpl, sleep: noSleep }, 'my-sprite', 'sess-1'),
    ).rejects.toThrow(/ECONNRESET/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('given retries are needed, waits with the same linear backoff withWakeRetry uses (500ms, 1000ms)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500, statusText: 'Internal Server Error' }));
    const delays: number[] = [];
    const sleep = async (ms: number) => { delays.push(ms); };

    await expect(killSpriteSession({ ...transport, fetchImpl, sleep }, 'my-sprite', 'sess-1')).rejects.toThrow();

    expect(delays).toEqual([500, 1000]);
  });
});

describe('withKillSession', () => {
  it('given a raw SDK-shaped sprite, adds a killSession method that calls the REST endpoint using the sprite\'s own name/client credentials', async () => {
    // withKillSession's killSession always calls killSpriteSession with no
    // fetchImpl override (it has no injection point of its own — production
    // wiring always wants the real global fetch), so this stubs the GLOBAL
    // fetch for the duration of the call rather than threading a fake through.
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      // Duck-typed like the real @fly/sprites `Sprite`: only `.name` and
      // `.client.{baseURL,token}` are read — everything else (spawn,
      // createSession, ...) passes through untouched via Object.assign.
      const sprite = {
        name: 'my-sprite',
        client: { baseURL: 'https://api.sprites.dev', token: 'test-token' },
        spawn: () => 'unrelated-spawn-marker',
      };

      const wrapped = withKillSession(sprite);
      await wrapped.killSession('sess-1');

      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('https://api.sprites.dev/v1/sprites/my-sprite/exec/sess-1/kill');
      expect(calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer test-token' } });
      expect(wrapped.spawn()).toBe('unrelated-spawn-marker'); // every other method survives untouched
      expect(wrapped).toBe(sprite); // mutates and returns the same instance, not a fresh wrapper
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
