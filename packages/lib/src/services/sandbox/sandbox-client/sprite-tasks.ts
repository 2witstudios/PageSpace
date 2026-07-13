/**
 * Sprites Tasks API hold — "work is in progress, don't pause this sprite".
 *
 * A task is a hold on the current run: while at least one task is live, the
 * Sprite runs (docs.sprites.dev/keeping-sprites-running). The documented
 * pattern is a heartbeat — a SHORT expiry refreshed on a SHORTER interval,
 * deleted on exit — so an undeleted hold always frees itself: 5-minute expiry
 * refreshed every 60 seconds gives four missed heartbeats of margin, and a
 * realtime-process restart can never leak a permanent hold.
 *
 * ENDPOINT SHAPE (verified 2026-07-12 against docs.sprites.dev and
 * https://sprites.dev/api): the Tasks API is served ONLY by the Sprite's own
 * management socket — `/.sprite/api.sock` inside the VM, virtual host
 * `sprite`, plain HTTP/JSON (`PUT/POST/DELETE http://sprite/v1/tasks[/:name]`,
 * body `{"expire": <seconds|"5m">}`). The public REST API (api.sprites.dev)
 * documents no tasks endpoints, and the pinned @fly/sprites SDK (0.0.1-rc37)
 * exposes no tasks primitive. So this "REST client" issues the documented
 * REST calls by EXEC'ING `curl --unix-socket` inside the sprite through the
 * SDK's spawn — the same authenticated exec channel every other operation
 * uses (same auth/config as the SDK, no second credential path). That is
 * semantically sound: a hold is only ever created/refreshed while work is in
 * progress (viewer attached or agent output flowing), i.e. while the sprite
 * is already awake — the exec never wakes a deliberately-paused sprite.
 *
 * Pure core / imperative shell: `planHold` (every lifecycle decision),
 * `isAgentOutputFlowing`, the argv builders and the response classifiers are
 * pure and unit-tested without mocks; `createSpriteTasksClient` (exec) and
 * `createTaskHoldController` (bookkeeping + serialized queue) are thin shells.
 *
 * Failure policy: best-effort throughout. A failed call is reported and
 * retried as a fresh create on the next tick; a lost hold means a possible
 * mid-run pause, which the checkpoint work (leaf 2-1) already survives.
 * Nothing here ever throws into the terminal handler.
 */

import type { SpriteCommandLike } from './sprites';

/** Hold expiry — the platform frees the task this long after its last refresh. */
export const TASK_HOLD_EXPIRE_SECONDS = 300;
/** Heartbeat cadence — refresh every 60s against the 5m expiry (4 missed beats of margin). */
export const TASK_HOLD_REFRESH_MS = 60_000;
/** Max task lifetime per creation (docs: 1 hour) — longer work re-creates the hold. */
export const TASK_HOLD_MAX_LIFETIME_MS = 60 * 60 * 1000;
/**
 * How recently the PTY must have produced output to count as "agent output is
 * flowing". Two refresh intervals: long enough that a thinking agent between
 * tool calls isn't declared idle, short enough that an agent sitting at its
 * prompt releases the hold within a couple of minutes so the sprite can pause.
 */
export const TASK_HOLD_AGENT_IDLE_MS = 2 * TASK_HOLD_REFRESH_MS;
/** Wall-clock bound on one tasks-API exec — holds are best-effort, never worth a hang. */
export const TASK_EXEC_TIMEOUT_MS = 10_000;

export type HoldAction = 'create' | 'refresh' | 'delete' | 'noop';

/**
 * Pure: what to do with this session's hold, now.
 *
 * `createdAt`/`lastRefreshAt` are OUR bookkeeping of the hold we believe is
 * live (undefined -> no hold). Transitions:
 *  - work in progress (attached viewer OR agent output flowing), no hold -> create
 *  - work in progress, hold older than the 1h max-task-lifetime  -> create
 *    (each creation lives at most 1h; longer work re-creates)
 *  - work in progress, last refresh older than the whole expiry   -> create
 *    (too many missed heartbeats — the platform already freed the task, so a
 *    "refresh" would be upserting a dead hold; bookkeeping restarts its clock)
 *  - work in progress, refresh interval elapsed                   -> refresh
 *  - work in progress, inside the refresh interval                -> noop
 *  - no work, hold exists                                         -> delete
 *    (let the sprite pause — that pausing is now real is WHY this exists)
 *  - no work, no hold                                             -> noop
 */
export function planHold({
  attached,
  agentRunning,
  createdAt,
  lastRefreshAt,
  expireSeconds = TASK_HOLD_EXPIRE_SECONDS,
  refreshMs = TASK_HOLD_REFRESH_MS,
  maxLifetimeMs = TASK_HOLD_MAX_LIFETIME_MS,
  now,
}: {
  attached: boolean;
  agentRunning: boolean;
  createdAt: number | undefined;
  lastRefreshAt: number | undefined;
  expireSeconds?: number;
  refreshMs?: number;
  maxLifetimeMs?: number;
  now: number;
}): HoldAction {
  const needHold = attached || agentRunning;
  const holdExists = createdAt !== undefined;
  if (!needHold) return holdExists ? 'delete' : 'noop';
  if (!holdExists) return 'create';
  if (now - createdAt >= maxLifetimeMs) return 'create';
  const last = lastRefreshAt ?? createdAt;
  if (now - last >= expireSeconds * 1000) return 'create';
  if (now - last >= refreshMs) return 'refresh';
  return 'noop';
}

/** Pure: does output this recent count as a running agent? Never-output -> idle. */
export function isAgentOutputFlowing({
  lastOutputAt,
  now,
  idleMs = TASK_HOLD_AGENT_IDLE_MS,
}: {
  lastOutputAt: number | undefined;
  now: number;
  idleMs?: number;
}): boolean {
  if (lastOutputAt === undefined) return false;
  return now - lastOutputAt < idleMs;
}

/** Task names are a URL path segment AND an exec argument — allow nothing else. */
const SAFE_TASK_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Pure: a 32-bit FNV-1a hash, hex-encoded. Not cryptographic — it only has to
 * keep two session keys that sanitize identically from claiming (and deleting)
 * each other's hold on a shared sprite.
 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Pure: the platform task name for one terminal session's hold. Deterministic
 * per session key (a reconnect refreshes the SAME hold), sanitized to
 * [a-z0-9-], hash-suffixed so keys that sanitize alike stay distinct, and
 * bounded to 63 chars (the platform's DNS-label-sized name budget).
 */
export function taskHoldName(sessionKey: string): string {
  const sanitized = sessionKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const prefix = `ps-hold-${sanitized}`.slice(0, 54).replace(/-+$/, '');
  return `${prefix}-${fnv1aHex(sessionKey)}`;
}

function assertSafeName(name: string): void {
  if (!SAFE_TASK_NAME.test(name)) {
    throw new TypeError(`Unsafe sprite task name: ${JSON.stringify(name)}`);
  }
}

function assertSafeExpiry(expireSeconds: number): void {
  if (
    !Number.isInteger(expireSeconds) ||
    expireSeconds <= 0 ||
    expireSeconds * 1000 > TASK_HOLD_MAX_LIFETIME_MS
  ) {
    throw new TypeError(`Sprite task expiry out of range: ${expireSeconds}`);
  }
}

/** Shared curl argv prefix: management socket, silent, status-code-only output, bounded. */
function curlBase(): string[] {
  return [
    '--unix-socket',
    '/.sprite/api.sock',
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '--max-time',
    '8',
  ];
}

/**
 * Pure: the exec argv for creating OR refreshing the hold — one idempotent
 * upsert (docs: `PUT /v1/tasks/:name` is Refresh/Create), so create-vs-refresh
 * is a bookkeeping distinction, never a wire race. The expiry is structurally
 * part of EVERY call: there is no argv this module can produce that creates a
 * hold without one, which is what makes a realtime restart leak-proof.
 */
export function taskUpsertExecArgs({
  name,
  expireSeconds,
}: {
  name: string;
  expireSeconds: number;
}): [string, string[]] {
  assertSafeName(name);
  assertSafeExpiry(expireSeconds);
  return [
    'curl',
    [
      ...curlBase(),
      '-X',
      'PUT',
      '-H',
      'Content-Type: application/json',
      '-d',
      JSON.stringify({ expire: expireSeconds }),
      `http://sprite/v1/tasks/${name}`,
    ],
  ];
}

/** Pure: the exec argv for deleting the hold (`DELETE /v1/tasks/:name`). */
export function taskDeleteExecArgs({ name }: { name: string }): [string, string[]] {
  assertSafeName(name);
  return ['curl', [...curlBase(), '-X', 'DELETE', `http://sprite/v1/tasks/${name}`]];
}

/** Pure: the `%{http_code}` write-out, or undefined for anything that isn't one. */
export function parseCurlStatus(stdout: string): number | undefined {
  const match = stdout.trim().match(/^(\d{3})$/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * Pure: did the call leave the desired state in place? Any 2xx does; a remove
 * whose task was already gone (404 — expired, or a concurrent delete) also
 * does. A non-zero curl exit is always a failure (curl writes `000` when it
 * never got a response).
 */
export function isHoldCallOk({
  action,
  exitCode,
  status,
}: {
  action: 'upsert' | 'remove';
  exitCode: number;
  status: number | undefined;
}): boolean {
  if (exitCode !== 0 || status === undefined) return false;
  if (status >= 200 && status < 300) return true;
  return action === 'remove' && status === 404;
}

/**
 * Pure: the hold cadence from the environment, defaulting to the documented
 * 5m expiry / 60s refresh. Invalid or out-of-range values fall back rather
 * than throw (a bad env var must not take terminals down), and the refresh is
 * always kept a genuine heartbeat — strictly inside the expiry window — so a
 * misconfiguration can never produce a hold that expires between beats.
 */
export function resolveTaskHoldConfig(
  env: Record<string, string | undefined>,
): { expireSeconds: number; refreshMs: number } {
  const rawExpire = Number.parseInt(env.SPRITE_TASK_HOLD_EXPIRE_SECONDS ?? '', 10);
  const expireSeconds =
    Number.isInteger(rawExpire) && rawExpire > 0 && rawExpire * 1000 <= TASK_HOLD_MAX_LIFETIME_MS
      ? rawExpire
      : TASK_HOLD_EXPIRE_SECONDS;
  const fallbackRefreshMs = Math.min(
    TASK_HOLD_REFRESH_MS,
    Math.max(1000, Math.floor((expireSeconds * 1000) / 5)),
  );
  const rawRefresh = Number.parseInt(env.SPRITE_TASK_HOLD_REFRESH_MS ?? '', 10);
  const refreshMs =
    Number.isInteger(rawRefresh) && rawRefresh > 0 && rawRefresh < expireSeconds * 1000
      ? rawRefresh
      : fallbackRefreshMs;
  return { expireSeconds, refreshMs };
}

export interface SpriteTaskCallResult {
  ok: boolean;
  status?: number;
}

export interface SpriteTasksClient {
  /** Create or refresh the named hold — one idempotent PUT upsert. */
  upsert(args: { name: string; expireSeconds: number }): Promise<SpriteTaskCallResult>;
  /** Delete the named hold; a hold that is already gone counts as success. */
  remove(args: { name: string }): Promise<SpriteTaskCallResult>;
}

/** The one Sprite capability this client consumes. */
export type SpriteTaskSpawnLike = {
  spawn(file: string, args?: string[]): SpriteCommandLike;
};

/**
 * Run one curl exec and collect its exit code + stdout, bounded by `timeoutMs`
 * (kill on expiry). Deliberately NOT `withWakeRetry`: holds only matter while
 * the sprite is already awake, and a failed best-effort call is degraded, not
 * retried inline — the controller's next tick is the retry.
 */
function runTaskExec(
  sprite: SpriteTaskSpawnLike,
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const command = sprite.spawn(file, args);
    const chunks: string[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        command.kill('SIGKILL');
      } catch {
        // Best-effort; the sprite reaps its own orphans.
      }
      reject(new Error(`Sprite tasks exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    command.stdout.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    command.stderr.on('data', () => {
      // Silenced (`-s`); listener kept so an SDK that buffers stderr never stalls.
    });
    command.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: chunks.join('') });
    });
    command.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * The tasks "REST client": the documented `/v1/tasks` calls, issued over the
 * sprite's management socket via the SDK's authenticated exec channel (see the
 * module doc for why that IS the sanctioned surface). Never throws — every
 * failure (bad name, transport error, timeout, non-2xx) resolves `ok: false`.
 */
export function createSpriteTasksClient({
  sprite,
  timeoutMs = TASK_EXEC_TIMEOUT_MS,
}: {
  sprite: SpriteTaskSpawnLike;
  timeoutMs?: number;
}): SpriteTasksClient {
  const call = async (
    action: 'upsert' | 'remove',
    build: () => [string, string[]],
  ): Promise<SpriteTaskCallResult> => {
    try {
      const [file, args] = build();
      const { exitCode, stdout } = await runTaskExec(sprite, file, args, timeoutMs);
      const status = parseCurlStatus(stdout);
      return { ok: isHoldCallOk({ action, exitCode, status }), status };
    } catch {
      return { ok: false };
    }
  };
  return {
    upsert: ({ name, expireSeconds }) => call('upsert', () => taskUpsertExecArgs({ name, expireSeconds })),
    remove: ({ name }) => call('remove', () => taskDeleteExecArgs({ name })),
  };
}

export interface TaskHoldState {
  /** Is a viewer currently attached to this terminal? */
  attached: boolean;
  /** When the PTY last produced output, if ever. */
  lastOutputAt: number | undefined;
}

export interface TaskHoldController {
  /** Re-evaluate the hold against the session's current state. Synchronous and non-throwing; the platform call (if any) runs on a serialized background queue. */
  tick(state: TaskHoldState): void;
  /** Session over: delete any live hold and go inert. Idempotent. */
  end(): void;
  /** The heartbeat cadence the owner should tick at (== refreshMs). */
  readonly tickIntervalMs: number;
}

/**
 * Per-session hold lifecycle: pure `planHold` decisions over private
 * bookkeeping, acted on through a SERIALIZED queue (so a delete can never
 * overtake the refresh before it, and `end()`'s delete always lands last).
 *
 * Bookkeeping is updated optimistically at decision time and RESET on a failed
 * upsert, so the very next tick retries as a fresh create instead of waiting
 * out a refresh interval it may no longer have. Failures are reported via
 * `onError` and otherwise swallowed — a hold is protection, never a
 * precondition (requirement: degrade gracefully; a lost hold means a possible
 * pause, which the checkpoint work already survives).
 */
export function createTaskHoldController({
  client,
  taskName,
  expireSeconds = TASK_HOLD_EXPIRE_SECONDS,
  refreshMs = TASK_HOLD_REFRESH_MS,
  maxLifetimeMs = TASK_HOLD_MAX_LIFETIME_MS,
  agentIdleMs = TASK_HOLD_AGENT_IDLE_MS,
  now = Date.now,
  onError,
}: {
  client: SpriteTasksClient;
  taskName: string;
  expireSeconds?: number;
  refreshMs?: number;
  maxLifetimeMs?: number;
  agentIdleMs?: number;
  now?: () => number;
  onError?: (stage: 'upsert' | 'delete', result: SpriteTaskCallResult) => void;
}): TaskHoldController {
  let createdAt: number | undefined;
  let lastRefreshAt: number | undefined;
  let ended = false;
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (op: () => Promise<void>): void => {
    queue = queue.then(op).catch(() => {});
  };

  const report = (stage: 'upsert' | 'delete', result: SpriteTaskCallResult): void => {
    try {
      onError?.(stage, result);
    } catch {
      // A logging callback must never break the hold loop.
    }
  };

  const enqueueRemove = (): void => {
    enqueue(async () => {
      let result: SpriteTaskCallResult;
      try {
        result = await client.remove({ name: taskName });
      } catch {
        result = { ok: false };
      }
      // A failed delete is only a delayed pause: the hold self-expires within
      // `expireSeconds` regardless — the leak-proofing lives in the expiry.
      if (!result.ok) report('delete', result);
    });
  };

  return {
    tickIntervalMs: refreshMs,

    tick({ attached, lastOutputAt }) {
      if (ended) return;
      const t = now();
      const action = planHold({
        attached,
        agentRunning: isAgentOutputFlowing({ lastOutputAt, now: t, idleMs: agentIdleMs }),
        createdAt,
        lastRefreshAt,
        expireSeconds,
        refreshMs,
        maxLifetimeMs,
        now: t,
      });
      if (action === 'noop') return;

      if (action === 'delete') {
        createdAt = undefined;
        lastRefreshAt = undefined;
        enqueueRemove();
        return;
      }

      // create | refresh — the same idempotent PUT upsert on the wire; only
      // the bookkeeping differs (create restarts the 1h-lifetime clock).
      if (action === 'create') createdAt = t;
      lastRefreshAt = t;
      enqueue(async () => {
        let result: SpriteTaskCallResult;
        try {
          result = await client.upsert({ name: taskName, expireSeconds });
        } catch {
          result = { ok: false };
        }
        if (!result.ok) {
          // Reset so the next tick plans a fresh create (an immediate retry).
          createdAt = undefined;
          lastRefreshAt = undefined;
          report('upsert', result);
        }
      });
    },

    end() {
      if (ended) return;
      ended = true;
      const hadHold = createdAt !== undefined;
      createdAt = undefined;
      lastRefreshAt = undefined;
      if (hadHold) enqueueRemove();
    },
  };
}
