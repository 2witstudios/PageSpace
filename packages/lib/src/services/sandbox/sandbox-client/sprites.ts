/**
 * Fly Sprites driver (IO) for the provider-neutral `ExecSandboxClient` seam.
 *
 * Implements PR2's `SandboxClient` lifecycle (getOrCreate / get / stop) and the
 * PR3 execution surface (runCommand / writeFiles / readFileToBuffer) against
 * `@fly/sprites`. A Sprite is named by the conversation session key, so
 * `getOrCreate` resumes an existing Sprite by name or creates a fresh one.
 *
 * Provisioning is locked down, never platform defaults:
 *  - **Egress** — the deny-by-default L3 network policy is (re-)applied on EVERY
 *    hand-back, whether the Sprite was just created or resumed by name. Sprites
 *    default to open outbound, so a Sprite reused after a crash between
 *    `createSprite` and its original lockdown would otherwise run the next
 *    command with open egress; reapplying on resume closes that window (and lets
 *    a tightened allowlist take effect on a warm session). On a FRESH Sprite a
 *    lockdown failure destroys it and rejects; on a RESUMED one we never destroy
 *    a warm session we don't own the lifecycle of, but we still refuse to hand it
 *    back — the call rejects so no command runs without a confirmed policy.
 *  - **Caps** — RAM / vCPUs / storage / region come from the resolved policy
 *    (`SpriteConfig`), set explicitly per Sprite rather than relying on the quota
 *    defaults.
 *  - **No secrets** — the allowlisted env is set by the caller via
 *    `buildSandboxEnv`; this driver injects none. v1 brokers no outbound
 *    credentials (a Fly Tokenizer proxy is the future path, out of scope).
 *
 * `stop` DESTROYS the Sprite (not a checkpoint) so there is no orphaned/idle
 * billing.
 *
 * The SDK's promise-based `exec`/`execFile` expose neither a per-command timeout
 * nor a handle to abort a running command, so the run is driven through `spawn`
 * — which takes the same `(file, args[])` structured form (NO host-side shell
 * string) and returns a `SpriteCommand` we can `kill('SIGKILL')`. We replicate
 * the SDK's own `execFile` stream collection (stdout/stderr `data` listeners,
 * `maxBuffer` cap, `exit` event) and add a HARD wall-clock timer that SIGKILLs
 * the command on expiry. The command, not the Sprite, is killed — the warm
 * conversation session survives a single slow run and the idle reaper reclaims
 * an abandoned VM.
 *
 * The SDK is injected (`sdk`) so the mapping — create/resume, policy lockdown,
 * exit/stdout/stderr surfacing, hard-timeout SIGKILL, get→null on a vanished
 * Sprite — is unit-tested with a fake, never against the real Sprites API.
 */

// SpritesClient is ESM-only. Instantiation lives in apps/web (sprites-client.ts)
// where Next.js handles the ESM import correctly. This module only holds the
// pure transformation logic and type-safe wrappers; it never touches the SDK.
import type { NetworkPolicy, SpriteConfig } from '@fly/sprites';
import { getValidatedEnv } from '../../../config/env-validation';
import { buildSpriteNetworkPolicy } from '../egress';
import { SANDBOX_ROOT } from '../sandbox-paths';
import type {
  ExecSandboxClient,
  ExecutableSandbox,
  SandboxRunResult,
  RunCommandArgs,
  WriteFileEntry,
} from './types';
import { SandboxProvisionError, type SandboxCreateOptions } from '../sandbox-options';

/** Thrown when a command exceeds the policy's per-run wall-clock cap. */
export class SandboxCommandTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Sandbox command timed out after ${timeoutMs}ms`);
    this.name = 'SandboxCommandTimeoutError';
  }
}

/** Thrown when a command's stdout/stderr exceeds the policy's output cap. */
export class SandboxOutputLimitError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Sandbox command output exceeded ${maxBytes} bytes`);
    this.name = 'SandboxOutputLimitError';
  }
}

// Hard ceiling on buffered command output when the policy supplies no cap. The
// SDK's own execFile default is 10MB; we mirror it so an unbounded stream can
// never exhaust the host process memory even on the (unreachable) no-cap path.
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** The Sprite filesystem subset the driver consumes. */
export interface SpriteFsLike {
  readFile(path: string, encoding: null): Promise<Buffer>;
  writeFile(path: string, data: string | Buffer, options?: { mode?: number }): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/** The readable-stream subset the driver consumes (stdout/stderr `data` events). */
export interface SpriteStreamLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/**
 * The running-command subset the driver consumes — mirrors the SDK's
 * `SpriteCommand`: buffered output via `stdout`/`stderr` `data` events, an `exit`
 * event carrying the code, an `error` event for transport failures, and
 * `kill(signal)` for the hard-timeout SIGKILL.
 *
 * `stdin` and `resize` are only populated when the command was spawned with
 * `tty: true` (PTY mode). Batch commands leave them undefined.
 */
export interface SpriteCommandLike {
  readonly stdout: SpriteStreamLike;
  readonly stderr: SpriteStreamLike;
  readonly stdin?: { write(data: string | Buffer): void };
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  kill(signal?: string): void;
  resize?(cols: number, rows: number): void;
}

/** Options for spawning a command, including PTY support. */
export interface SpriteSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  tty?: boolean;
  rows?: number;
  cols?: number;
}

/** The Sprite instance subset the driver consumes. */
export interface SpriteInstanceLike {
  readonly name: string;
  spawn(
    file: string,
    args?: string[],
    options?: SpriteSpawnOptions,
  ): SpriteCommandLike;
  filesystem(workingDir?: string): SpriteFsLike;
  updateNetworkPolicy(policy: NetworkPolicy): Promise<void>;
  destroy(): Promise<void>;
}

/** The injectable Sprites SDK statics. Defaults to the real `@fly/sprites`. */
export interface SpritesSdk {
  getSprite(name: string): Promise<SpriteInstanceLike>;
  createSprite(name: string, config?: SpriteConfig): Promise<SpriteInstanceLike>;
  deleteSprite(name: string): Promise<void>;
}

/**
 * Resolve the Sprites API token from validated env. Returns '' (→ the SDK's
 * calls fail-closed with an auth error, surfaced as a provisioning failure)
 * rather than throwing at construction, so a missing token disables execution
 * instead of crashing the app.
 */
export function resolveSpritesToken(): string {
  try {
    return getValidatedEnv().SPRITES_API_TOKEN ?? '';
  } catch {
    return '';
  }
}

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
}

/**
 * Run a command through the SDK's `spawn` (structured `file` + `args[]`, never a
 * host-side shell string) and buffer its output. Faithfully replicates the SDK's
 * own `execFile` collection — stdout/stderr `data` listeners with a `maxBuffer`
 * cap, resolve on the `exit` event — and layers on a HARD wall-clock timer that
 * `kill('SIGKILL')`s the command on expiry (the SDK's promise-based exec exposes
 * no timeout and no abort handle, hence `spawn`). A non-zero exit is a RESULT,
 * not a failure, so it resolves with its code; only a transport error, an output
 * overflow, or a timeout rejects. The first settle wins and always clears the
 * timer.
 */
function runSpawned(
  command: SpriteCommandLike,
  maxBytes: number,
  timeoutMs: number | undefined,
): Promise<SandboxRunResult> {
  const maxBuffer = maxBytes > 0 ? maxBytes : DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise<SandboxRunResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const fail = (error: unknown) => settle(() => reject(error));
    const succeed = (result: SandboxRunResult) => settle(() => resolve(result));

    const collect = (chunks: Buffer[], chunk: Buffer | string, len: number): number => {
      // Once settled (overflow / timeout / exit) stop retaining: late chunks from
      // a not-yet-dead command must not grow memory past the run we already ended.
      if (settled) return len;
      const buf = toBuffer(chunk);
      const next = len + buf.length;
      if (next > maxBuffer) {
        // Output flood: SIGKILL the firehose and fail WITHOUT retaining the
        // overflowing chunk, so buffered memory never exceeds the cap (a DoS
        // guard on host memory).
        try {
          command.kill('SIGKILL');
        } catch {
          // Best-effort kill; the wall-clock timer / idle reaper still bound it.
        }
        fail(new SandboxOutputLimitError(maxBuffer));
        return len;
      }
      chunks.push(buf);
      return next;
    };

    command.stdout.on('data', (chunk) => {
      stdoutLen = collect(stdoutChunks, chunk, stdoutLen);
    });
    command.stderr.on('data', (chunk) => {
      stderrLen = collect(stderrChunks, chunk, stderrLen);
    });
    command.on('exit', (code) => {
      succeed({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    command.on('error', (error) => {
      fail(error);
    });

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        // The SDK exec API exposes no timeout, so we enforce it: SIGKILL the
        // command (not the Sprite) and reject. The warm session survives; the
        // runner records the anomaly and fails this run.
        try {
          command.kill('SIGKILL');
        } catch {
          // Best-effort; an unkillable command is reclaimed by the idle reaper.
        }
        fail(new SandboxCommandTimeoutError(timeoutMs));
      }, timeoutMs);
    }
  });
}

// Cold-start exec retry. A hibernated Sprite wakes on the exec WebSocket, and
// Fly's wake-on-request can drop the FIRST connection while the VM boots — the
// SDK surfaces that as a "closed before open" error. That failure is provably
// pre-open (the command never started), so retrying it is safe and is the
// documented wake handshake. We retry ONLY that signal: a post-open failure
// (timeout, output overflow, non-zero exit, mid-command socket drop) may have
// already run the command and must NOT be retried.
const MAX_EXEC_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const FS_OP_TIMEOUT_MS = 30_000;

function isPreOpenWakeError(error: unknown): boolean {
  if (error instanceof SandboxCommandTimeoutError || error instanceof SandboxOutputLimitError) {
    return false;
  }
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  // Emitted by the SDK's WSCommand before the socket ever opens — see
  // @fly/sprites websocket.js ("WebSocket closed before open: …").
  return msg.includes('closed before open');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn + collect with a bounded retry on the cold-start wake handshake. The
 * command is (re-)spawned per attempt via `spawnFn` so each retry opens a fresh
 * WebSocket. Only a pre-open wake failure is retried; everything else propagates
 * on the first occurrence.
 */
async function runSpawnedWithWakeRetry(
  spawnFn: () => SpriteCommandLike,
  maxBytes: number,
  timeoutMs: number | undefined,
): Promise<SandboxRunResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_EXEC_ATTEMPTS; attempt += 1) {
    try {
      return await runSpawned(spawnFn(), maxBytes, timeoutMs);
    } catch (error) {
      lastError = error;
      if (!isPreOpenWakeError(error) || attempt === MAX_EXEC_ATTEMPTS) throw error;
      await delay(RETRY_BASE_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

/** Reject if `p` has not settled within `ms` — the Sprite filesystem API uses a
 *  bare fetch with no AbortSignal and hangs on a cold/hibernated VM, so every fs
 *  op must be wall-clock bounded by the caller. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SandboxCommandTimeoutError(ms)),
      ms,
    );
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  }).catch((error) => {
    if (error instanceof SandboxCommandTimeoutError) {
      throw new Error(`Sandbox filesystem ${label} timed out after ${ms}ms`);
    }
    throw error;
  });
}

/** Force a hibernated VM awake via the designated exec/WebSocket path (a cheap
 *  no-op), with the same cold-start retry as a real command. Used to recover a
 *  filesystem op that hit a cold VM before retrying it. */
async function wakeSprite(sprite: SpriteInstanceLike): Promise<void> {
  await runSpawnedWithWakeRetry(
    () => sprite.spawn('sh', ['-c', ':']),
    DEFAULT_MAX_OUTPUT_BYTES,
    FS_OP_TIMEOUT_MS,
  );
}

/**
 * Run a filesystem op bounded by a timeout; on the first failure (cold-start
 * hang/race) wake the VM via the exec path and retry once. The filesystem API
 * itself never wakes a cold VM and never times out, so without this a `writeFile`
 * / `readFile` against a hibernated Sprite hangs indefinitely.
 */
async function fsWithWakeRetry<T>(
  sprite: SpriteInstanceLike,
  label: string,
  op: () => Promise<T>,
): Promise<T> {
  try {
    return await withTimeout(op(), FS_OP_TIMEOUT_MS, label);
  } catch {
    await wakeSprite(sprite);
    return await withTimeout(op(), FS_OP_TIMEOUT_MS, label);
  }
}

function wrap(sprite: SpriteInstanceLike): ExecutableSandbox {
  return {
    sandboxId: sprite.name,

    async runCommand({ cmd, args = [], cwd, env, timeoutMs, maxBytes }: RunCommandArgs): Promise<SandboxRunResult> {
      // spawn (arg array), never a host-side shell string. The untrusted command
      // runs under the Sprite's own `sh -c`, contained by the VM. Re-spawned per
      // attempt so a cold-start wake drop reconnects on a fresh WebSocket.
      return runSpawnedWithWakeRetry(() => sprite.spawn(cmd, args, { cwd, env }), maxBytes ?? 0, timeoutMs);
    },

    async writeFiles(files: WriteFileEntry[]): Promise<void> {
      const fs = sprite.filesystem('/');
      for (const file of files) {
        const data = typeof file.content === 'string' ? file.content : Buffer.from(file.content);
        // Bounded + wake-on-cold: the fs API hangs on a hibernated VM otherwise.
        await fsWithWakeRetry(sprite, 'write', () =>
          fs.writeFile(file.path, data, file.mode === undefined ? undefined : { mode: file.mode }),
        );
      }
    },

    async readFileToBuffer({ path }: { path: string }): Promise<Buffer | null> {
      try {
        return await fsWithWakeRetry(sprite, 'read', () => sprite.filesystem('/').readFile(path, null));
      } catch {
        // A missing file (or any read failure after a wake retry) resolves to
        // null; the runner maps null to a handled not-found rather than throwing.
        return null;
      }
    },
  };
}

/**
 * Whether an error from `sdk.getSprite` means the named Sprite does not exist —
 * a cache miss that should create-fresh (`getOrCreate`) or reconnect-null
 * (`get`). Auth failures, rate limits, and control-plane outages must NOT be
 * treated as "vanished": swallowing them would spuriously create a duplicate
 * Sprite under a name that still has a live VM (orphaning it), or silently tear
 * down and re-provision a healthy session. The `@fly/sprites` RC SDK exports no
 * typed `NotFoundError`, so we classify defensively on HTTP status / error code
 * and fall back to a conservative message match; a KNOWN non-404 status is never
 * a cache miss.
 */
export function isSpriteNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  const status =
    typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? e.statusCode
        : undefined;
  // 404 Not Found / 410 Gone both mean the named Sprite is no longer there.
  if (status === 404 || status === 410) return true;
  // Any other explicit HTTP status (401/403/429/5xx) is an error to surface.
  if (status !== undefined) return false;
  const code = typeof e.code === 'string' ? e.code.toUpperCase() : '';
  if (code === 'NOT_FOUND' || code === 'ENOTFOUND' || code === 'ERR_NOT_FOUND') return true;
  const name = typeof e.name === 'string' ? e.name : '';
  if (/notfound/i.test(name)) return true;
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return /\bnot found\b|no such|does not exist|\b404\b|\b410\b|\bgone\b|vanished/.test(message);
}

/**
 * Map a raw `@fly/sprites` error into a normalized {@link SandboxProvisionError}.
 * Defensive (duck-typed, like `isSpriteNotFoundError`) because the RC SDK exports
 * no stable typed errors: a creation/concurrent rate limit (`429` /
 * `sprite_creation_rate_limited` / `concurrent_sprite_limit_exceeded`) becomes
 * `rate_limited` with a retry hint; a name/state conflict (`409`) becomes
 * `conflict` (the delete-then-recreate race); anything else is `unavailable`. So
 * the lifecycle can surface a distinct, actionable reason instead of one opaque
 * `provision_failed`.
 */
export function classifyProvisionError(error: unknown): SandboxProvisionError {
  if (error instanceof SandboxProvisionError) return error;
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    status?: unknown;
    statusCode?: unknown;
    errorCode?: unknown;
    code?: unknown;
    retryAfterSeconds?: unknown;
    retryAfterHeader?: unknown;
    message?: unknown;
  };
  const status =
    typeof e.statusCode === 'number' ? e.statusCode : typeof e.status === 'number' ? e.status : undefined;
  const errorCode = typeof e.errorCode === 'string' ? e.errorCode : typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  const retryAfterSeconds =
    typeof e.retryAfterSeconds === 'number'
      ? e.retryAfterSeconds
      : typeof e.retryAfterHeader === 'number'
        ? e.retryAfterHeader
        : undefined;

  if (
    status === 429 ||
    errorCode === 'sprite_creation_rate_limited' ||
    errorCode === 'concurrent_sprite_limit_exceeded' ||
    /\brate limit|too many requests\b/.test(message)
  ) {
    return new SandboxProvisionError('rate_limited', retryAfterSeconds, error);
  }
  if (status === 409 || /already exists|conflict/.test(message)) {
    return new SandboxProvisionError('conflict', retryAfterSeconds, error);
  }
  return new SandboxProvisionError('unavailable', retryAfterSeconds, error);
}

// Apply the deny-by-default egress policy and ensure the sandbox root exists.
// Called on every hand-back (fresh or resumed) so a Sprite is never returned
// with open/unknown egress. When `destroyOnFailure` is set (a FRESH create), a
// lockdown failure destroys the just-created Sprite before propagating; on a
// resumed Sprite we never destroy a warm session, but the error still propagates
// so the caller refuses to hand back a Sprite without a confirmed policy.
async function applyEgressLockdown({
  sdk,
  sprite,
  options,
  destroyOnFailure,
}: {
  sdk: SpritesSdk;
  sprite: SpriteInstanceLike;
  options: SandboxCreateOptions;
  destroyOnFailure: boolean;
}): Promise<void> {
  try {
    await sprite.updateNetworkPolicy(buildSpriteNetworkPolicy({ egressAllowlist: options.egressAllowlist }));
    // Use spawn + runSpawned (30 s wall-clock) to create the workspace dir instead
    // of filesystem().mkdir(). The filesystem API uses a bare fetch() with no
    // AbortSignal — it hangs for 52–90 s when the Sprite VM is cold-booting and
    // Fly's proxy eventually closes the connection. spawn() connects via WebSocket
    // which is the designated wake-up path; runSpawned enforces the timeout and
    // SIGKILLs if the Sprite never becomes ready.
    await runSpawnedWithWakeRetry(() => sprite.spawn('mkdir', ['-p', SANDBOX_ROOT]), DEFAULT_MAX_OUTPUT_BYTES, 30_000);
  } catch (error) {
    if (destroyOnFailure) {
      try {
        await sdk.deleteSprite(sprite.name);
      } catch {
        // Best-effort cleanup of a Sprite we refuse to hand back.
      }
    }
    throw error;
  }
}

export function createSpritesSandboxClient({ sdk }: { sdk: SpritesSdk }): ExecSandboxClient {
  return {
    async getOrCreate({ name, options }) {
      // Resume by name when the Sprite already exists; create fresh ONLY on a
      // genuine not-found. Auth/rate-limit/outage errors from getSprite surface
      // rather than spawning a duplicate Sprite under a name that may still be live.
      //
      // The Sprites API enforces a 63-char name limit (DNS label). Our session
      // keys are 72-char HMAC hex strings; truncate to 63 before hitting the API.
      // The full key stays as the DB session key — only the Sprites name is short.
      const spriteName = name.slice(0, 63);
      try {
        let sprite: SpriteInstanceLike;
        let fresh = false;
        try {
          sprite = await sdk.getSprite(spriteName);
        } catch (error) {
          if (!isSpriteNotFoundError(error)) throw error;
          // Caps (RAM / vCPUs / storage / region) come from the resolved policy and
          // are set explicitly per Sprite rather than relying on the quota defaults.
          sprite = await sdk.createSprite(spriteName, options.caps);
          fresh = true;
        }
        // Re-apply the deny-default egress lockdown on BOTH paths — see file header.
        await applyEgressLockdown({ sdk, sprite, options, destroyOnFailure: fresh });
        return wrap(sprite);  // wrap sets sandboxId = sprite.name = spriteName (truncated)
      } catch (error) {
        // Normalize every provisioning failure (rate limit / conflict / outage)
        // so the lifecycle can surface a distinct reason instead of one opaque
        // `provision_failed`.
        throw classifyProvisionError(error);
      }
    },

    async get({ sandboxId }) {
      // Reconnect by name; a genuinely vanished Sprite (not-found) → null so the
      // lifecycle re-provisions under the same key. Other errors (auth, rate
      // limit, outage) surface rather than masquerading as a vanished session.
      try {
        return wrap(await sdk.getSprite(sandboxId));
      } catch (error) {
        if (isSpriteNotFoundError(error)) return null;
        throw error;
      }
    },

    async stop({ sandboxId }) {
      // DESTROY, not checkpoint — no orphaned/idle billing.
      await sdk.deleteSprite(sandboxId);
    },
  };
}
