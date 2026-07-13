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

import { runSpawned, type SpriteCommandLike } from './sprites';

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

/**
 * Pure: does activity this recent count as a running agent? Never-active ->
 * idle. "Activity" is deliberately wider than output: typed input (a prompt
 * that kicks off a long silent run) and the PTY launch itself both count, so
 * a viewer who types and detaches before the agent's first byte doesn't get
 * their agent's hold deleted out from under a run that has already started.
 */
export function isAgentActive({
  lastActivityAt,
  now,
  idleMs = TASK_HOLD_AGENT_IDLE_MS,
}: {
  lastActivityAt: number | undefined;
  now: number;
  idleMs?: number;
}): boolean {
  if (lastActivityAt === undefined) return false;
  return now - lastActivityAt < idleMs;
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
  // Single-pass character map — no backtracking-capable regex over the
  // caller-controlled key (CodeQL: polynomial regex on uncontrolled data).
  const lower = sessionKey.toLowerCase();
  let sanitized = '';
  for (let i = 0; i < lower.length && sanitized.length < 45; i += 1) {
    const ch = lower[i];
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      sanitized += ch;
    } else if (sanitized.length > 0 && !sanitized.endsWith('-')) {
      sanitized += '-';
    }
  }
  while (sanitized.endsWith('-')) sanitized = sanitized.slice(0, -1);
  const prefix = sanitized.length > 0 ? `ps-hold-${sanitized}` : 'ps-hold';
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
 * Pure: an env var as a positive integer, or undefined. Digits-only by
 * construction — `Number.parseInt('5m')` is 5, so a lenient parse would turn
 * `SPRITE_TASK_HOLD_EXPIRE_SECONDS=5m` into five SECONDS instead of falling
 * back; the same convention the repo's other `envInt` helpers use.
 */
function envPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,15}$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : undefined;
}

/**
 * Pure: the hold cadence from the environment, defaulting to the documented
 * 5m expiry / 60s refresh. Invalid or out-of-range values fall back rather
 * than throw (a bad env var must not take terminals down), and the refresh is
 * always kept a genuine heartbeat — at most HALF the expiry window, so timer
 * jitter on a beat can never coincide with the hold's own expiry (a refresh
 * of expiry−ε would otherwise leave a recurring no-hold gap every interval).
 */
export function resolveTaskHoldConfig(
  env: Record<string, string | undefined>,
): { expireSeconds: number; refreshMs: number } {
  const rawExpire = envPositiveInt(env.SPRITE_TASK_HOLD_EXPIRE_SECONDS);
  const expireSeconds =
    rawExpire !== undefined && rawExpire * 1000 <= TASK_HOLD_MAX_LIFETIME_MS
      ? rawExpire
      : TASK_HOLD_EXPIRE_SECONDS;
  const maxRefreshMs = Math.max(1000, Math.floor((expireSeconds * 1000) / 2));
  const fallbackRefreshMs = Math.min(
    TASK_HOLD_REFRESH_MS,
    Math.max(1000, Math.floor((expireSeconds * 1000) / 5)),
  );
  const rawRefresh = envPositiveInt(env.SPRITE_TASK_HOLD_REFRESH_MS);
  const refreshMs =
    rawRefresh !== undefined && rawRefresh <= maxRefreshMs ? rawRefresh : fallbackRefreshMs;
  return { expireSeconds, refreshMs };
}

export interface SpriteTaskCallResult {
  ok: boolean;
  /** The parsed HTTP status, when the exec produced one. */
  status?: number;
  /** The exec's exit code, when it ran — 127 pinpoints a missing curl binary. */
  exitCode?: number;
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
 * Output cap for one hold exec — the whole expected payload is a 3-digit
 * `%{http_code}` write-out, so anything past a few KB is a misbehaving exec
 * that `runSpawned` should kill rather than buffer.
 */
const TASK_EXEC_MAX_OUTPUT_BYTES = 4096;

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
      // runSpawned (sprites.ts) is the driver's own collect-bounded-output-or-
      // kill executor: hard timeout with SIGKILL, output cap, exit-code-as-
      // result. Deliberately NOT wrapped in `withWakeRetry` — holds only
      // matter while the sprite is already awake, and a failed best-effort
      // call is degraded, not retried inline (the controller's next tick is
      // the retry).
      const { exitCode, stdout } = await runSpawned(
        sprite.spawn(file, args),
        TASK_EXEC_MAX_OUTPUT_BYTES,
        timeoutMs,
      );
      const status = parseCurlStatus(stdout);
      return { ok: isHoldCallOk({ action, exitCode, status }), status, exitCode };
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
  /** When the PTY was last ACTIVE — launch, typed input, or produced output — if ever (see {@link isAgentActive}). */
  lastActivityAt: number | undefined;
  /**
   * Can the caller still OBSERVE activity? While a viewer is attached the
   * exec WebSocket is kept alive (the shell's watchdog reconnects), so "no
   * output for N minutes" is real data. While DETACHED the shell deliberately
   * never reconnects a dropped socket (leaf 3-2), so the activity clock can
   * freeze under an agent that is still working. FRESH activity is always
   * trustworthy evidence of work (we saw the bytes); STALE activity is only
   * trustworthy evidence of idleness when this is true. When false, an
   * existing hold is kept refreshed (until the session ends or is reaped —
   * a bounded ~30min) rather than deleted on a clock that may be blind.
   * Defaults to true.
   */
  activityObservable?: boolean;
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
 * out a refresh interval it may no longer have. `mayHoldRemotely` is the one
 * flag that survives that reset: a PUT that REPORTED failure may still have
 * landed (curl killed after the request was applied), so `end()` keys its
 * final delete on "was an upsert ever attempted since the last delete", never
 * on the retry bookkeeping — otherwise a failed-then-closed session would
 * leak its hold for the full expiry.
 *
 * Blind-staleness policy (see {@link TaskHoldState.activityObservable}):
 * fresh activity always counts as work; STALE activity only counts as
 * idleness when the caller can still observe activity. When it can't
 * (detached, exec socket dropped and deliberately not reconnected — leaf
 * 3-2), an existing hold is kept refreshed instead of deleted on a frozen
 * clock; the session's own end/reap (bounded, ~30min) is what releases it.
 *
 * A re-create over a possibly-live task (the 1h max-lifetime boundary)
 * DELETEs before PUTting: the platform's max task lifetime is per CREATION,
 * so a plain upsert would refresh a task the platform still retires at the
 * original creation+1h — bookkeeping would then claim an hour the platform
 * never granted.
 *
 * Failures are reported via `onError` (with the exec exit code / HTTP status,
 * so a missing-curl 127 is distinguishable from an API error) and otherwise
 * swallowed — a hold is protection, never a precondition (requirement:
 * degrade gracefully; a lost hold means a possible pause, which the
 * checkpoint work already survives).
 */
export function createTaskHoldController({
  client,
  taskName,
  expireSeconds = TASK_HOLD_EXPIRE_SECONDS,
  refreshMs = TASK_HOLD_REFRESH_MS,
  agentIdleMs,
  now = Date.now,
  onError,
}: {
  client: SpriteTasksClient;
  taskName: string;
  expireSeconds?: number;
  refreshMs?: number;
  /** How stale activity may be before a DETACHED-but-observable agent counts as idle. Defaults to two refresh intervals, whatever the refresh cadence is configured to. */
  agentIdleMs?: number;
  now?: () => number;
  onError?: (stage: 'upsert' | 'delete', result: SpriteTaskCallResult) => void;
}): TaskHoldController {
  const idleMs = agentIdleMs ?? 2 * refreshMs;
  let createdAt: number | undefined;
  let lastRefreshAt: number | undefined;
  let mayHoldRemotely = false;
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
    mayHoldRemotely = false;
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

    tick({ attached, lastActivityAt, activityObservable = true }) {
      if (ended) return;
      const t = now();
      // Fresh activity is always evidence of work (we saw the bytes). Stale
      // activity is only evidence of IDLENESS while activity is observable;
      // blind (detached, socket gone), an existing hold outweighs the frozen
      // clock — see the blind-staleness policy in the function doc.
      const agentRunning =
        isAgentActive({ lastActivityAt, now: t, idleMs }) ||
        (!activityObservable && createdAt !== undefined);
      const hadBookkeeping = createdAt !== undefined;
      const action = planHold({
        attached,
        agentRunning,
        createdAt,
        lastRefreshAt,
        expireSeconds,
        refreshMs,
        now: t,
      });
      if (action === 'noop') return;

      if (action === 'delete') {
        createdAt = undefined;
        lastRefreshAt = undefined;
        enqueueRemove();
        return;
      }

      // create | refresh — the same idempotent PUT upsert on the wire, EXCEPT
      // a re-create over a task the platform may still be tracking (the 1h
      // max-lifetime boundary): its lifetime is per CREATION, so that one is
      // DELETE-then-PUT to genuinely restart the platform's clock.
      const recreateOverLiveTask = action === 'create' && hadBookkeeping;
      if (action === 'create') createdAt = t;
      lastRefreshAt = t;
      mayHoldRemotely = true;
      enqueue(async () => {
        let result: SpriteTaskCallResult;
        try {
          if (recreateOverLiveTask) {
            // Best-effort delete first; 404 (already expired) is success.
            await client.remove({ name: taskName });
          }
          result = await client.upsert({ name: taskName, expireSeconds });
        } catch {
          result = { ok: false };
        }
        if (!result.ok) {
          // Reset so the next tick plans a fresh create (an immediate retry).
          // `mayHoldRemotely` deliberately stays true: the PUT may have
          // landed even though we could not read its answer.
          createdAt = undefined;
          lastRefreshAt = undefined;
          report('upsert', result);
        }
      });
    },

    end() {
      if (ended) return;
      ended = true;
      createdAt = undefined;
      lastRefreshAt = undefined;
      if (mayHoldRemotely) enqueueRemove();
    },
  };
}
