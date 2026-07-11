import { describe, it } from 'vitest';
import { assert } from '../../__tests__/riteway';
import {
  isPreOpenWakeError,
  planWakeRetry,
  wakeRetryDelayMs,
  withWakeRetry,
  createSpriteHandleCache,
  MAX_EXEC_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  SandboxCommandTimeoutError,
  SandboxOutputLimitError,
  type SpritesSdk,
  type SpriteInstanceLike,
} from '../sprites';

const preOpen = () => new Error('WebSocket closed before open: code=1006');

describe('isPreOpenWakeError', () => {
  it('classifies only the provably pre-open cold-start drop as retryable', () => {
    assert({
      given: 'the SDK\'s "closed before open" WebSocket error',
      should: 'be a retryable pre-open wake drop',
      actual: isPreOpenWakeError(preOpen()),
      expected: true,
    });

    assert({
      given: 'a command timeout (the command may already have run)',
      should: 'NOT be retryable',
      actual: isPreOpenWakeError(new SandboxCommandTimeoutError(30_000)),
      expected: false,
    });

    assert({
      given: 'an output-limit overflow (the command definitely ran)',
      should: 'NOT be retryable',
      actual: isPreOpenWakeError(new SandboxOutputLimitError(1024)),
      expected: false,
    });

    assert({
      given: 'a mid-command socket drop',
      should: 'NOT be retryable',
      actual: isPreOpenWakeError(new Error('socket hang up')),
      expected: false,
    });

    assert({
      given: 'a non-Error rejection value',
      should: 'NOT be retryable',
      actual: isPreOpenWakeError('boom'),
      expected: false,
    });
  });
});

describe('wakeRetryDelayMs', () => {
  it('is a linear backoff over the attempt number', () => {
    assert({
      given: 'attempts 1..3 at the default base delay',
      should: 'back off linearly (500ms, 1000ms, 1500ms)',
      actual: [1, 2, 3].map((attempt) => wakeRetryDelayMs(attempt)),
      expected: [RETRY_BASE_DELAY_MS, RETRY_BASE_DELAY_MS * 2, RETRY_BASE_DELAY_MS * 3],
    });
  });
});

describe('planWakeRetry', () => {
  it('retries a pre-open drop on the bounded schedule and gives up at the cap', () => {
    assert({
      given: 'a pre-open drop on the first attempt',
      should: 'retry after the base delay',
      actual: planWakeRetry({ error: preOpen(), attempt: 1 }),
      expected: { retry: true, delayMs: RETRY_BASE_DELAY_MS },
    });

    assert({
      given: 'a pre-open drop on the second attempt',
      should: 'retry after twice the base delay',
      actual: planWakeRetry({ error: preOpen(), attempt: 2 }),
      expected: { retry: true, delayMs: RETRY_BASE_DELAY_MS * 2 },
    });

    assert({
      given: 'a pre-open drop on the final allowed attempt',
      should: 'stop retrying (bounded — never an infinite wake loop)',
      actual: planWakeRetry({ error: preOpen(), attempt: MAX_EXEC_ATTEMPTS }),
      expected: { retry: false },
    });

    assert({
      given: 'a post-open failure on the first attempt',
      should: 'not retry (the command may already have run)',
      actual: planWakeRetry({ error: new Error('socket hang up'), attempt: 1 }),
      expected: { retry: false },
    });
  });
});

describe('withWakeRetry', () => {
  it('given a cold op that drops pre-open twice, should re-run it on the bounded backoff and resolve', async () => {
    const slept: number[] = [];
    let attempts = 0;
    const value = await withWakeRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw preOpen();
        return 'awake';
      },
      { sleep: async (ms) => { slept.push(ms); } },
    );

    assert({
      given: 'a cold operation dropped pre-open twice',
      should: 'resolve on the third attempt',
      actual: { value, attempts },
      expected: { value: 'awake', attempts: 3 },
    });

    assert({
      given: 'two pre-open retries',
      should: 'have waited the linear backoff between them',
      actual: slept,
      expected: [RETRY_BASE_DELAY_MS, RETRY_BASE_DELAY_MS * 2],
    });
  });

  it('given an op that always drops pre-open, should give up after the bounded attempt cap', async () => {
    let attempts = 0;
    let thrown: unknown;
    try {
      await withWakeRetry(
        async () => {
          attempts += 1;
          throw preOpen();
        },
        { sleep: async () => {} },
      );
    } catch (error) {
      thrown = error;
    }

    assert({
      given: 'a Sprite that never wakes',
      should: 'attempt exactly MAX_EXEC_ATTEMPTS times, then propagate the error',
      actual: { attempts, message: (thrown as Error).message },
      expected: { attempts: MAX_EXEC_ATTEMPTS, message: preOpen().message },
    });
  });

  it('given a post-open failure, should propagate it on the FIRST occurrence (never re-run a command that may have run)', async () => {
    let attempts = 0;
    try {
      await withWakeRetry(
        async () => {
          attempts += 1;
          throw new Error('socket hang up');
        },
        { sleep: async () => {} },
      );
    } catch {
      // expected
    }

    assert({
      given: 'a mid-command failure',
      should: 'run the operation exactly once',
      actual: attempts,
      expected: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// createSpriteHandleCache — the "one getSprite per connect" collapse
// ---------------------------------------------------------------------------

function fakeSprite(name: string): SpriteInstanceLike {
  return {
    name,
    spawn: () => { throw new Error('not used'); },
    createSession: () => { throw new Error('not used'); },
    attachSession: () => { throw new Error('not used'); },
    listSessions: async () => [],
    filesystem: () => { throw new Error('not used'); },
    updateNetworkPolicy: async () => {},
    destroy: async () => {},
  };
}

function countingSdk(over: Partial<SpritesSdk> = {}) {
  const calls = { getSprite: [] as string[], createSprite: [] as string[], deleteSprite: [] as string[] };
  const sdk: SpritesSdk = {
    getSprite: async (name) => {
      calls.getSprite.push(name);
      return fakeSprite(name);
    },
    createSprite: async (name) => {
      calls.createSprite.push(name);
      return fakeSprite(name);
    },
    deleteSprite: async (name) => {
      calls.deleteSprite.push(name);
    },
    ...over,
  };
  return { sdk, calls };
}

describe('createSpriteHandleCache', () => {
  it('given repeated reads of one Sprite, should call sdk.getSprite exactly once and hand back the same handle', async () => {
    const { sdk, calls } = countingSdk();
    const cached = createSpriteHandleCache(sdk);

    const [a, b, c] = await Promise.all([
      cached.getSprite('machine-1'),
      cached.getSprite('machine-1'),
      cached.getSprite('machine-1'),
    ]);

    assert({
      given: 'three reads of the same Sprite through one cache',
      should: 'issue exactly one sdk.getSprite call',
      actual: calls.getSprite,
      expected: ['machine-1'],
    });

    assert({
      given: 'three reads of the same Sprite through one cache',
      should: 'hand back the identical handle each time',
      actual: a === b && b === c,
      expected: true,
    });
  });

  it('given distinct Sprites, should not collapse them onto one handle', async () => {
    const { sdk, calls } = countingSdk();
    const cached = createSpriteHandleCache(sdk);

    const one = await cached.getSprite('machine-1');
    const two = await cached.getSprite('machine-2');

    assert({
      given: 'two different Sprite names',
      should: 'read each one exactly once, keyed by name',
      actual: { calls: calls.getSprite, names: [one.name, two.name] },
      expected: { calls: ['machine-1', 'machine-2'], names: ['machine-1', 'machine-2'] },
    });
  });

  it('given a fresh create (getSprite rejects not-found, then createSprite), should serve later reads from the created handle without a second getSprite', async () => {
    const { sdk, calls } = countingSdk({
      getSprite: async (name) => {
        calls.getSprite.push(name);
        throw Object.assign(new Error('not found'), { status: 404 });
      },
    });
    const cached = createSpriteHandleCache(sdk);

    // The getOrCreate shape: probe, miss, create.
    await cached.getSprite('machine-1').catch(() => {});
    const created = await cached.createSprite('machine-1');
    // A later consumer (the PTY launch resolution) reads the same name.
    const reread = await cached.getSprite('machine-1');

    assert({
      given: 'a probe-miss + create, then a re-read of the same name',
      should: 'issue exactly ONE getSprite (the probe) — the create seeds the cache',
      actual: calls.getSprite,
      expected: ['machine-1'],
    });

    assert({
      given: 'a re-read after a fresh create',
      should: 'hand back the just-created handle',
      actual: reread === created,
      expected: true,
    });
  });

  it('given a transient getSprite failure, should NOT cache the rejection (a later read retries)', async () => {
    let attempts = 0;
    const { sdk } = countingSdk({
      getSprite: async (name) => {
        attempts += 1;
        if (attempts === 1) throw new Error('rate limited');
        return fakeSprite(name);
      },
    });
    const cached = createSpriteHandleCache(sdk);

    await cached.getSprite('machine-1').catch(() => {});
    const sprite = await cached.getSprite('machine-1');

    assert({
      given: 'a first read that failed transiently',
      should: 'retry the read rather than replay the cached rejection forever',
      actual: { attempts, name: sprite.name },
      expected: { attempts: 2, name: 'machine-1' },
    });
  });

  it('given a deleted Sprite, should evict it so a later read is a genuine re-read', async () => {
    const { sdk, calls } = countingSdk();
    const cached = createSpriteHandleCache(sdk);

    await cached.getSprite('machine-1');
    await cached.deleteSprite('machine-1');
    await cached.getSprite('machine-1');

    assert({
      given: 'a read, a delete, then a read of the same name',
      should: 'not serve the destroyed Sprite from cache',
      actual: { get: calls.getSprite, deleted: calls.deleteSprite },
      expected: { get: ['machine-1', 'machine-1'], deleted: ['machine-1'] },
    });
  });
});
