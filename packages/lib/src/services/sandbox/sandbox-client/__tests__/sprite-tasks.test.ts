import { describe, it } from 'vitest';
import { assert } from '../../__tests__/riteway';
import {
  planHold,
  isAgentActive,
  taskHoldName,
  taskUpsertExecArgs,
  taskDeleteExecArgs,
  parseCurlStatus,
  isHoldCallOk,
  createSpriteTasksClient,
  createTaskHoldController,
  resolveTaskHoldConfig,
  TASK_HOLD_EXPIRE_SECONDS,
  TASK_HOLD_REFRESH_MS,
  TASK_HOLD_MAX_LIFETIME_MS,
  TASK_HOLD_AGENT_IDLE_MS,
  type SpriteTasksClient,
  type SpriteTaskCallResult,
} from '../sprite-tasks';
import type { SpriteCommandLike } from '../sprites';

const T0 = 1_000_000; // an arbitrary fixed "now" — the pure core never reads the clock

/** planHold inputs for the common "hold should exist" case, overridable per assertion. */
function holdInputs(over: Partial<Parameters<typeof planHold>[0]> = {}): Parameters<typeof planHold>[0] {
  return {
    attached: true,
    agentRunning: false,
    createdAt: undefined,
    lastRefreshAt: undefined,
    expireSeconds: TASK_HOLD_EXPIRE_SECONDS,
    refreshMs: TASK_HOLD_REFRESH_MS,
    maxLifetimeMs: TASK_HOLD_MAX_LIFETIME_MS,
    now: T0,
    ...over,
  };
}

describe('planHold', () => {
  it('creates a hold when work is in progress and none exists', () => {
    assert({
      given: 'a viewer attached and no existing hold',
      should: 'create',
      actual: planHold(holdInputs()),
      expected: 'create',
    });

    assert({
      given: 'agent output flowing with no viewer and no existing hold',
      should: 'create',
      actual: planHold(holdInputs({ attached: false, agentRunning: true })),
      expected: 'create',
    });
  });

  it('is a noop while a live hold is inside its refresh interval', () => {
    assert({
      given: 'a hold refreshed less than the refresh interval ago',
      should: 'noop',
      actual: planHold(
        holdInputs({ createdAt: T0 - 10_000, lastRefreshAt: T0 - 10_000 }),
      ),
      expected: 'noop',
    });

    assert({
      given: 'a hold created (never refreshed) less than the refresh interval ago',
      should: 'noop',
      actual: planHold(holdInputs({ createdAt: T0 - 10_000 })),
      expected: 'noop',
    });
  });

  it('refreshes on the heartbeat cadence', () => {
    assert({
      given: 'a hold whose last refresh is exactly one refresh interval old',
      should: 'refresh',
      actual: planHold(
        holdInputs({
          createdAt: T0 - TASK_HOLD_REFRESH_MS,
          lastRefreshAt: T0 - TASK_HOLD_REFRESH_MS,
        }),
      ),
      expected: 'refresh',
    });

    assert({
      given: 'a hold with several missed heartbeats but still inside its expiry margin',
      should: 'refresh (the 5m expiry gives four missed heartbeats of margin)',
      actual: planHold(
        holdInputs({
          createdAt: T0 - 4 * TASK_HOLD_REFRESH_MS,
          lastRefreshAt: T0 - 4 * TASK_HOLD_REFRESH_MS,
        }),
      ),
      expected: 'refresh',
    });
  });

  it('re-creates a hold that has expired server-side (missed too many heartbeats)', () => {
    assert({
      given: 'a hold whose last refresh is older than the whole expiry window',
      should: 'create (the platform already freed the task; a refresh names a dead hold)',
      actual: planHold(
        holdInputs({
          createdAt: T0 - TASK_HOLD_EXPIRE_SECONDS * 1000,
          lastRefreshAt: T0 - TASK_HOLD_EXPIRE_SECONDS * 1000,
        }),
      ),
      expected: 'create',
    });
  });

  it('re-creates at the 1h max-task-lifetime boundary', () => {
    assert({
      given: 'a hold created 1h ago and refreshed every minute since',
      should: 'create (max task lifetime per creation is 1h — longer work re-creates)',
      actual: planHold(
        holdInputs({
          createdAt: T0 - TASK_HOLD_MAX_LIFETIME_MS,
          lastRefreshAt: T0 - TASK_HOLD_REFRESH_MS,
        }),
      ),
      expected: 'create',
    });

    assert({
      given: 'a hold created just under 1h ago, due an ordinary refresh',
      should: 'refresh',
      actual: planHold(
        holdInputs({
          createdAt: T0 - TASK_HOLD_MAX_LIFETIME_MS + 1,
          lastRefreshAt: T0 - TASK_HOLD_REFRESH_MS,
        }),
      ),
      expected: 'refresh',
    });
  });

  it('deletes the hold when no work is in progress', () => {
    assert({
      given: 'a live hold, viewer detached, agent idle',
      should: 'delete (let the sprite pause)',
      actual: planHold(
        holdInputs({
          attached: false,
          agentRunning: false,
          createdAt: T0 - 10_000,
          lastRefreshAt: T0 - 10_000,
        }),
      ),
      expected: 'delete',
    });

    assert({
      given: 'no hold, viewer detached, agent idle',
      should: 'noop',
      actual: planHold(holdInputs({ attached: false, agentRunning: false })),
      expected: 'noop',
    });
  });

  it('keeps holding for a detached viewer while agent output flows', () => {
    assert({
      given: 'viewer detached but agent output flowing, hold due a refresh',
      should: 'refresh',
      actual: planHold(
        holdInputs({
          attached: false,
          agentRunning: true,
          createdAt: T0 - TASK_HOLD_REFRESH_MS,
          lastRefreshAt: T0 - TASK_HOLD_REFRESH_MS,
        }),
      ),
      expected: 'refresh',
    });
  });
});

describe('isAgentActive', () => {
  it('treats recent activity as a running agent', () => {
    assert({
      given: 'activity inside the idle window',
      should: 'be active',
      actual: isAgentActive({ lastActivityAt: T0 - 1_000, now: T0, idleMs: TASK_HOLD_AGENT_IDLE_MS }),
      expected: true,
    });

    assert({
      given: 'activity exactly one idle window old',
      should: 'be idle',
      actual: isAgentActive({
        lastActivityAt: T0 - TASK_HOLD_AGENT_IDLE_MS,
        now: T0,
        idleMs: TASK_HOLD_AGENT_IDLE_MS,
      }),
      expected: false,
    });

    assert({
      given: 'no activity ever recorded',
      should: 'be idle',
      actual: isAgentActive({ lastActivityAt: undefined, now: T0, idleMs: TASK_HOLD_AGENT_IDLE_MS }),
      expected: false,
    });
  });
});

describe('taskHoldName', () => {
  it('derives a URL/exec-safe task name from a session key', () => {
    const name = taskHoldName('branch1:agent:cli');
    assert({
      given: 'a session key with separator characters',
      should: 'produce only [a-z0-9-] characters',
      actual: /^[a-z0-9-]+$/.test(name),
      expected: true,
    });
  });

  it('is deterministic and collision-resistant across keys that sanitize alike', () => {
    assert({
      given: 'the same session key twice',
      should: 'produce the same name',
      actual: taskHoldName('a:b') === taskHoldName('a:b'),
      expected: true,
    });

    assert({
      given: 'two keys that differ only in separator characters',
      should: 'produce different names (one terminal must not delete a sibling hold)',
      actual: taskHoldName('a:b') === taskHoldName('a-b'),
      expected: false,
    });
  });

  it('stays within the task-name length budget for very long keys', () => {
    assert({
      given: 'a 72-char HMAC-hex session key',
      should: 'produce a name no longer than 63 chars',
      actual: taskHoldName('f'.repeat(72)).length <= 63,
      expected: true,
    });
  });
});

describe('taskUpsertExecArgs', () => {
  it('PUTs the documented upsert with an ALWAYS-set expiry', () => {
    const [file, args] = taskUpsertExecArgs({ name: 'ps-hold-x', expireSeconds: 300 });
    assert({
      given: 'an upsert argv',
      should: 'exec curl against the in-sprite management socket',
      actual: file === 'curl' && args.includes('--unix-socket') && args.includes('/.sprite/api.sock'),
      expected: true,
    });

    assert({
      given: 'an upsert argv',
      should: 'PUT the named task on the documented path',
      actual: args.includes('PUT') && args.includes('http://sprite/v1/tasks/ps-hold-x'),
      expected: true,
    });

    // Requirement: a realtime restart must leave only self-expiring holds —
    // so the expiry is structurally part of EVERY create/refresh call.
    assert({
      given: 'an upsert argv',
      should: 'always carry the expiry in the body',
      actual: args.includes('{"expire":300}'),
      expected: true,
    });
  });

  it('rejects a task name that is not exec/URL-safe', () => {
    let threw = false;
    try {
      taskUpsertExecArgs({ name: 'bad name/../x', expireSeconds: 300 });
    } catch {
      threw = true;
    }
    assert({
      given: 'a task name with unsafe characters',
      should: 'throw rather than interpolate it into an exec/URL',
      actual: threw,
      expected: true,
    });
  });

  it('rejects a non-positive or out-of-range expiry', () => {
    let threw = false;
    try {
      taskUpsertExecArgs({ name: 'ok-name', expireSeconds: 0 });
    } catch {
      threw = true;
    }
    assert({
      given: 'a zero expiry (a task that would never hold)',
      should: 'throw',
      actual: threw,
      expected: true,
    });

    let threwOverMax = false;
    try {
      taskUpsertExecArgs({ name: 'ok-name', expireSeconds: 3601 });
    } catch {
      threwOverMax = true;
    }
    assert({
      given: 'an expiry above the 1h max task lifetime',
      should: 'throw',
      actual: threwOverMax,
      expected: true,
    });
  });
});

describe('taskDeleteExecArgs', () => {
  it('DELETEs the named task on the documented path', () => {
    const [file, args] = taskDeleteExecArgs({ name: 'ps-hold-x' });
    assert({
      given: 'a delete argv',
      should: 'DELETE the named task over the management socket',
      actual:
        file === 'curl' &&
        args.includes('DELETE') &&
        args.includes('http://sprite/v1/tasks/ps-hold-x') &&
        args.includes('/.sprite/api.sock'),
      expected: true,
    });
  });
});

describe('parseCurlStatus', () => {
  it('reads the %{http_code} write-out', () => {
    assert({
      given: 'a bare status code with whitespace',
      should: 'parse it',
      actual: parseCurlStatus(' 201\n'),
      expected: 201,
    });

    assert({
      given: 'curl noise instead of a status',
      should: 'be undefined',
      actual: parseCurlStatus('curl: (7) Failed to connect'),
      expected: undefined,
    });

    assert({
      given: 'empty output',
      should: 'be undefined',
      actual: parseCurlStatus(''),
      expected: undefined,
    });
  });
});

describe('isHoldCallOk', () => {
  it('accepts 2xx for upsert, and 2xx or 404 for remove', () => {
    assert({
      given: 'an upsert that returned 200',
      should: 'be ok',
      actual: isHoldCallOk({ action: 'upsert', exitCode: 0, status: 200 }),
      expected: true,
    });

    assert({
      given: 'an upsert that returned 404',
      should: 'not be ok',
      actual: isHoldCallOk({ action: 'upsert', exitCode: 0, status: 404 }),
      expected: false,
    });

    assert({
      given: 'a remove whose task was already gone (404)',
      should: 'be ok (the desired state holds)',
      actual: isHoldCallOk({ action: 'remove', exitCode: 0, status: 404 }),
      expected: true,
    });

    assert({
      given: 'a remove that returned 204',
      should: 'be ok',
      actual: isHoldCallOk({ action: 'remove', exitCode: 0, status: 204 }),
      expected: true,
    });
  });

  it('fails a call whose curl exec itself failed', () => {
    assert({
      given: 'a non-zero curl exit (connection failure writes 000)',
      should: 'not be ok',
      actual: isHoldCallOk({ action: 'upsert', exitCode: 7, status: 0 }),
      expected: false,
    });

    assert({
      given: 'an unparsable status',
      should: 'not be ok',
      actual: isHoldCallOk({ action: 'remove', exitCode: 0, status: undefined }),
      expected: false,
    });
  });
});

describe('resolveTaskHoldConfig', () => {
  it('defaults to the documented 5m expiry / 60s refresh', () => {
    assert({
      given: 'an env with no overrides',
      should: 'use the documented defaults',
      actual: resolveTaskHoldConfig({}),
      expected: { expireSeconds: TASK_HOLD_EXPIRE_SECONDS, refreshMs: TASK_HOLD_REFRESH_MS },
    });
  });

  it('honors valid overrides', () => {
    assert({
      given: 'a valid expiry and refresh override',
      should: 'use them',
      actual: resolveTaskHoldConfig({
        SPRITE_TASK_HOLD_EXPIRE_SECONDS: '600',
        SPRITE_TASK_HOLD_REFRESH_MS: '120000',
      }),
      expected: { expireSeconds: 600, refreshMs: 120_000 },
    });
  });

  it('rejects garbage and out-of-range values back to safe settings', () => {
    assert({
      given: 'a non-numeric expiry and a refresh no shorter than the expiry',
      should: 'fall back to defaults / a refresh inside the expiry',
      actual: resolveTaskHoldConfig({
        SPRITE_TASK_HOLD_EXPIRE_SECONDS: 'soon',
        SPRITE_TASK_HOLD_REFRESH_MS: String(TASK_HOLD_EXPIRE_SECONDS * 1000),
      }),
      expected: { expireSeconds: TASK_HOLD_EXPIRE_SECONDS, refreshMs: TASK_HOLD_REFRESH_MS },
    });

    const overMax = resolveTaskHoldConfig({ SPRITE_TASK_HOLD_EXPIRE_SECONDS: '7200' });
    assert({
      given: 'an expiry above the 1h max task lifetime',
      should: 'fall back to the default expiry',
      actual: overMax.expireSeconds,
      expected: TASK_HOLD_EXPIRE_SECONDS,
    });
  });

  it('keeps the refresh a genuine heartbeat under a short custom expiry', () => {
    const config = resolveTaskHoldConfig({ SPRITE_TASK_HOLD_EXPIRE_SECONDS: '30' });
    assert({
      given: 'a 30s expiry with the default 60s refresh now too slow',
      should: 'shrink the refresh below the expiry',
      actual: config.refreshMs < config.expireSeconds * 1000,
      expected: true,
    });
  });

  it('rejects duration-suffixed values instead of silently truncating them', () => {
    assert({
      given: "an expiry of '5m' (parseInt would read it as five SECONDS)",
      should: 'fall back to the default rather than mis-parse',
      actual: resolveTaskHoldConfig({ SPRITE_TASK_HOLD_EXPIRE_SECONDS: '5m' }).expireSeconds,
      expected: TASK_HOLD_EXPIRE_SECONDS,
    });
  });

  it('caps the refresh at half the expiry so jitter can never straddle it', () => {
    const config = resolveTaskHoldConfig({
      SPRITE_TASK_HOLD_EXPIRE_SECONDS: '300',
      SPRITE_TASK_HOLD_REFRESH_MS: '299999',
    });
    assert({
      given: 'a refresh one millisecond under the expiry',
      should: 'fall back — a beat must land well inside the window it extends',
      actual: config.refreshMs <= (config.expireSeconds * 1000) / 2,
      expected: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Thin shells below — exercised with hand-rolled fakes (no mocking library).
// ---------------------------------------------------------------------------

type Listener = (...args: never[]) => void;

/** A hand-rolled SpriteCommandLike whose exit/error/output the test drives. */
function fakeCommand() {
  const listeners = new Map<string, Listener[]>();
  const on = (event: string, listener: Listener) => {
    const list = listeners.get(event) ?? [];
    list.push(listener);
    listeners.set(event, list);
  };
  const fire = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  };
  let killed: string | undefined;
  const command: SpriteCommandLike = {
    stdout: { on: (event, listener) => on(`stdout:${event}`, listener as Listener) },
    stderr: { on: (event, listener) => on(`stderr:${event}`, listener as Listener) },
    on: (event: string, listener: Listener) => on(event, listener),
    kill: (signal?: string) => {
      killed = signal ?? 'SIGKILL';
    },
  } as SpriteCommandLike;
  return {
    command,
    emitStdout: (data: string) => fire('stdout:data', data),
    exit: (code: number) => fire('exit', code),
    error: (error: unknown) => fire('error', error),
    wasKilled: () => killed !== undefined,
  };
}

describe('createSpriteTasksClient', () => {
  it('reports ok on a successful upsert exec', async () => {
    const spawned: Array<{ file: string; args: string[] }> = [];
    const fake = fakeCommand();
    const client = createSpriteTasksClient({
      sprite: {
        spawn: (file: string, args?: string[]) => {
          spawned.push({ file, args: args ?? [] });
          return fake.command;
        },
      },
    });

    const pending = client.upsert({ name: 'ps-hold-x', expireSeconds: 300 });
    fake.emitStdout('200');
    fake.exit(0);
    const result = await pending;

    assert({
      given: 'a curl exec that exits 0 with a 200 status',
      should: 'be ok with the parsed status and exit code',
      actual: result,
      expected: { ok: true, status: 200, exitCode: 0 },
    });

    assert({
      given: 'the spawned argv',
      should: 'carry the expiry (self-expiring holds only)',
      actual: spawned[0].args.includes('{"expire":300}'),
      expected: true,
    });
  });

  it('degrades to ok:false on transport errors instead of throwing', async () => {
    const fake = fakeCommand();
    const client = createSpriteTasksClient({
      sprite: { spawn: () => fake.command },
    });

    const pending = client.remove({ name: 'ps-hold-x' });
    fake.error(new Error('WebSocket closed before open'));
    const result = await pending;

    assert({
      given: 'an exec whose socket errored',
      should: 'resolve ok:false rather than reject',
      actual: result.ok,
      expected: false,
    });
  });

  it('kills and fails an exec that outlives its timeout', async () => {
    const fake = fakeCommand();
    const client = createSpriteTasksClient({
      sprite: { spawn: () => fake.command },
      timeoutMs: 5,
    });

    const result = await client.upsert({ name: 'ps-hold-x', expireSeconds: 300 });

    assert({
      given: 'an exec that never exits',
      should: 'resolve ok:false after the timeout',
      actual: result.ok,
      expected: false,
    });

    assert({
      given: 'an exec that never exits',
      should: 'have been killed',
      actual: fake.wasKilled(),
      expected: true,
    });
  });

  it('refuses an invalid name without throwing to the caller', async () => {
    let spawnCalls = 0;
    const client = createSpriteTasksClient({
      sprite: {
        spawn: () => {
          spawnCalls += 1;
          return fakeCommand().command;
        },
      },
    });

    const result = await client.upsert({ name: 'bad name', expireSeconds: 300 });

    assert({
      given: 'an unsafe task name',
      should: 'resolve ok:false without ever spawning',
      actual: { ok: result.ok, spawnCalls },
      expected: { ok: false, spawnCalls: 0 },
    });
  });
});

describe('createTaskHoldController', () => {
  function fakeClient(results: { upsert?: SpriteTaskCallResult; remove?: SpriteTaskCallResult } = {}) {
    const calls: Array<{ op: 'upsert' | 'remove'; name: string; expireSeconds?: number }> = [];
    const client: SpriteTasksClient = {
      upsert: async ({ name, expireSeconds }) => {
        calls.push({ op: 'upsert', name, expireSeconds });
        return results.upsert ?? { ok: true, status: 200 };
      },
      remove: async ({ name }) => {
        calls.push({ op: 'remove', name });
        return results.remove ?? { ok: true, status: 204 };
      },
    };
    return { client, calls };
  }

  /** Let the controller's internal op queue drain. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('creates on the first attached tick and refreshes on the cadence', async () => {
    let now = T0;
    const { client, calls } = fakeClient();
    const controller = createTaskHoldController({
      client,
      taskName: 'ps-hold-x',
      now: () => now,
    });

    controller.tick({ attached: true, lastActivityAt: undefined });
    await settle();

    assert({
      given: 'the first tick with a viewer attached',
      should: 'create the hold (one upsert)',
      actual: calls.map((c) => c.op),
      expected: ['upsert'],
    });

    now += 10_000;
    controller.tick({ attached: true, lastActivityAt: undefined });
    await settle();

    assert({
      given: 'a tick inside the refresh interval',
      should: 'not call the platform again',
      actual: calls.length,
      expected: 1,
    });

    now += TASK_HOLD_REFRESH_MS;
    controller.tick({ attached: true, lastActivityAt: undefined });
    await settle();

    assert({
      given: 'a tick past the refresh interval',
      should: 'refresh (a second upsert)',
      actual: calls.map((c) => c.op),
      expected: ['upsert', 'upsert'],
    });
  });

  it('deletes the hold on detach with an idle agent', async () => {
    let now = T0;
    const { client, calls } = fakeClient();
    const controller = createTaskHoldController({ client, taskName: 'ps-hold-x', now: () => now });

    controller.tick({ attached: true, lastActivityAt: undefined });
    await settle();
    now += 1_000;
    controller.tick({ attached: false, lastActivityAt: undefined });
    await settle();

    assert({
      given: 'a detach with no agent output',
      should: 'delete the hold so the sprite can pause',
      actual: calls.map((c) => c.op),
      expected: ['upsert', 'remove'],
    });

    now += 1_000;
    controller.tick({ attached: false, lastActivityAt: undefined });
    await settle();

    assert({
      given: 'further detached-idle ticks',
      should: 'stay quiet (no hold to delete)',
      actual: calls.length,
      expected: 2,
    });
  });

  it('holds through a detach while agent output is flowing', async () => {
    let now = T0;
    const { client, calls } = fakeClient();
    const controller = createTaskHoldController({ client, taskName: 'ps-hold-x', now: () => now });

    controller.tick({ attached: true, lastActivityAt: undefined });
    await settle();

    // Viewer leaves; agent is mid-run (output seconds ago).
    now += TASK_HOLD_REFRESH_MS;
    controller.tick({ attached: false, lastActivityAt: now - 1_000 });
    await settle();

    assert({
      given: 'a detached viewer with output still flowing',
      should: 'keep refreshing the hold',
      actual: calls.map((c) => c.op),
      expected: ['upsert', 'upsert'],
    });

    // Output stops; the agent goes idle past the idle window.
    now += TASK_HOLD_AGENT_IDLE_MS + 1;
    controller.tick({ attached: false, lastActivityAt: now - TASK_HOLD_AGENT_IDLE_MS - 1 });
    await settle();

    assert({
      given: 'the agent going idle while detached',
      should: 'delete the hold',
      actual: calls.map((c) => c.op),
      expected: ['upsert', 'upsert', 'remove'],
    });
  });

  it('retries as a fresh create after a failed upsert (lost hold, graceful degrade)', async () => {
    let now = T0;
    let failNext = true;
    const calls: Array<'upsert' | 'remove'> = [];
    const client: SpriteTasksClient = {
      upsert: async () => {
        calls.push('upsert');
        if (failNext) {
          failNext = false;
          return { ok: false };
        }
        return { ok: true, status: 200 };
      },
      remove: async () => {
        calls.push('remove');
        return { ok: true, status: 204 };
      },
    };
    const errors: string[] = [];
    const controller = createTaskHoldController({
      client,
      taskName: 'ps-hold-x',
      now: () => now,
      onError: (stage) => errors.push(stage),
    });

    controller.tick({ attached: true, lastActivityAt: undefined });
    await settle();

    assert({
      given: 'a failed create',
      should: 'report the failure and carry on',
      actual: errors,
      expected: ['upsert'],
    });

    now += 1_000; // well inside the refresh interval — only the failure forces a retry
    controller.tick({ attached: true, lastActivityAt: undefined });
    await settle();

    assert({
      given: 'the next tick after a failed create',
      should: 'retry the create immediately rather than wait a full cadence',
      actual: calls,
      expected: ['upsert', 'upsert'],
    });
  });

  it('never throws out of tick when the client itself throws', async () => {
    const controller = createTaskHoldController({
      client: {
        upsert: async () => {
          throw new Error('boom');
        },
        remove: async () => {
          throw new Error('boom');
        },
      },
      taskName: 'ps-hold-x',
      now: () => T0,
    });

    controller.tick({ attached: true, lastActivityAt: undefined });
    await settle();
    controller.end();
    await settle();

    assert({
      given: 'a client that throws on every call',
      should: 'swallow the failure (holds are best-effort)',
      actual: true,
      expected: true,
    });
  });

  it('deletes the hold on end() and goes inert', async () => {
    let now = T0;
    const { client, calls } = fakeClient();
    const controller = createTaskHoldController({ client, taskName: 'ps-hold-x', now: () => now });

    controller.tick({ attached: true, lastActivityAt: undefined });
    await settle();
    controller.end();
    await settle();

    assert({
      given: 'session end with a live hold',
      should: 'delete it',
      actual: calls.map((c) => c.op),
      expected: ['upsert', 'remove'],
    });

    now += TASK_HOLD_REFRESH_MS * 2;
    controller.tick({ attached: true, lastActivityAt: now });
    await settle();

    assert({
      given: 'a tick after end()',
      should: 'do nothing',
      actual: calls.length,
      expected: 2,
    });
  });

  it('does not call the platform on end() when no hold was ever created', async () => {
    const { client, calls } = fakeClient();
    const controller = createTaskHoldController({ client, taskName: 'ps-hold-x', now: () => T0 });

    controller.end();
    await settle();

    assert({
      given: 'end() with no hold',
      should: 'not exec anything',
      actual: calls.length,
      expected: 0,
    });
  });

  it('still deletes on end() after a reported-failed upsert (the PUT may have landed)', async () => {
    const { client, calls } = fakeClient({ upsert: { ok: false, exitCode: 28 } });
    const controller = createTaskHoldController({ client, taskName: 'ps-hold-x', now: () => T0 });

    controller.tick({ attached: true, lastActivityAt: undefined });
    await settle();
    controller.end();
    await settle();

    assert({
      given: 'an upsert whose exec timed out AFTER the request may have applied',
      should: 'delete on end() anyway — bookkeeping resets must not skip the cleanup',
      actual: calls.map((c) => c.op),
      expected: ['upsert', 'remove'],
    });
  });

  it('keeps a blind detached hold instead of trusting a frozen activity clock', async () => {
    let now = T0;
    const { client, calls } = fakeClient();
    const controller = createTaskHoldController({ client, taskName: 'ps-hold-x', now: () => now });

    controller.tick({ attached: true, lastActivityAt: now });
    await settle();

    // Viewer detaches; the exec socket then dies (leaf 3-2 never reconnects
    // it), so activity can no longer be observed. The clock is now well past
    // the idle window (2×refresh) but inside the hold's expiry:
    now += TASK_HOLD_REFRESH_MS * 3;
    controller.tick({ attached: false, lastActivityAt: T0, activityObservable: false });
    await settle();

    assert({
      given: 'a detached, unobservable session with a live hold and a stale clock',
      should: 'keep refreshing the hold rather than deleting under a possibly-working agent',
      actual: calls.map((c) => c.op),
      expected: ['upsert', 'upsert'],
    });

    assert({
      given: 'a blind refresh',
      should: 'never issue a remove',
      actual: calls.some((c) => c.op === 'remove'),
      expected: false,
    });
  });

  it('stays quiet while blind when no hold exists (blindness must not CREATE work)', async () => {
    const { client, calls } = fakeClient();
    const controller = createTaskHoldController({ client, taskName: 'ps-hold-x', now: () => T0 });

    controller.tick({ attached: false, lastActivityAt: undefined, activityObservable: false });
    await settle();

    assert({
      given: 'a blind tick with no live hold and no fresh activity',
      should: 'do nothing',
      actual: calls.length,
      expected: 0,
    });
  });

  it('re-creates over a possibly-live task with DELETE-then-PUT at the 1h lifetime boundary', async () => {
    let now = T0;
    const { client, calls } = fakeClient();
    const controller = createTaskHoldController({ client, taskName: 'ps-hold-x', now: () => now });

    controller.tick({ attached: true, lastActivityAt: now });
    await settle();

    // Refreshed along the way; the platform still retires the task at the
    // ORIGINAL creation + 1h, so the re-create must genuinely re-create.
    now += TASK_HOLD_MAX_LIFETIME_MS;
    controller.tick({ attached: true, lastActivityAt: now });
    await settle();

    assert({
      given: 'a hold reaching the platform max-task-lifetime boundary',
      should: 'DELETE the old task before PUTting the new one (a bare upsert would not restart the platform clock)',
      actual: calls.map((c) => c.op),
      expected: ['upsert', 'remove', 'upsert'],
    });
  });

  it('derives the idle window from the configured refresh cadence', async () => {
    let now = T0;
    const { client, calls } = fakeClient();
    const refreshMs = 10_000;
    const controller = createTaskHoldController({ client, taskName: 'ps-hold-x', refreshMs, now: () => now });

    controller.tick({ attached: true, lastActivityAt: now });
    await settle();

    // Detached, observable, activity 1.5 refresh intervals old: inside the
    // derived 2×refresh idle window, so still running.
    now += refreshMs * 1.5;
    controller.tick({ attached: false, lastActivityAt: T0 });
    await settle();

    assert({
      given: 'activity 1.5 refresh intervals old under a custom cadence',
      should: 'still count as running (idle window scales with the cadence)',
      actual: calls.map((c) => c.op),
      expected: ['upsert', 'upsert'],
    });

    now += refreshMs;
    controller.tick({ attached: false, lastActivityAt: T0 });
    await settle();

    assert({
      given: 'activity 2.5 refresh intervals old',
      should: 'now be idle and delete',
      actual: calls.map((c) => c.op),
      expected: ['upsert', 'upsert', 'remove'],
    });
  });
});
