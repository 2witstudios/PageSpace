/**
 * Fly Sprites driver (IO) for the provider-neutral `ExecSandboxClient` seam.
 *
 * Implements PR2's `SandboxClient` lifecycle (getOrCreate / get / stop) and the
 * PR3 execution surface (runCommand / writeFiles / readFileToBuffer) against
 * `@fly/sprites`. A Sprite is named by the conversation session key, so
 * `getOrCreate` resumes an existing Sprite by name or creates a fresh one.
 *
 * Provisioning is locked down, never platform defaults:
 *  - **Egress** — the deny-by-default L3 network policy is applied when it is not
 *    already known-good: on a FRESH create (a new Sprite starts with the
 *    platform's open outbound), on a hash mismatch (the desired policy changed),
 *    and when the caller records no applied hash at all (unknown → fail closed).
 *    A warm resume whose recorded hash still matches skips it: the policy is a
 *    persistent file (`/.sprite/policy/network.json`) that survives hibernation,
 *    so re-pushing an identical policy on every hand-back was pure chatter on the
 *    connect critical path. The crash window the old unconditional re-apply
 *    defended (a crash between `createSprite` and its lockdown) is closed by
 *    ORDERING instead: the caller links the session only after `getOrCreate`
 *    resolves, so an unlocked Sprite is never reachable from a session row. See
 *    `../egress-lockdown.ts`. On a FRESH Sprite a lockdown failure destroys it and
 *    rejects; on a RESUMED one we never destroy a warm session we don't own the
 *    lifecycle of, but we still refuse to hand it back — the call rejects so no
 *    command runs without a confirmed policy.
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
import { buildSpriteNetworkPolicy } from '../egress';
import { hashPolicy, shouldApplyPolicy } from '../egress-lockdown';
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
  /**
   * A server control frame, forwarded verbatim. In TTY mode the SDK JSON-parses
   * every inbound TEXT frame and re-emits it here (binary frames are terminal
   * output) — which is how the exec session's own `session_info` reaches us; see
   * {@link readSessionInfoId}.
   */
  on(event: 'message', listener: (message: unknown) => void): unknown;
  // Emitted by the SDK's WSCommand AFTER the WebSocket actually opens
  // (`cmd.start().then(() => cmd.emit('spawn'))`). A failed/flapping attach
  // rejects and emits 'error' instead, never 'spawn' — so 'spawn' is the
  // authoritative, flap-safe "connection established" signal the terminal uses
  // to reset its bounded reconnect budget.
  on(event: 'spawn', listener: () => void): unknown;
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

/**
 * An exec session as reported by `listSessions()` (GET `/v1/sprites/{name}/exec`).
 * The `id` is the handle passed to `attachSession` (WSS `/v1/sprites/{name}/exec/{id}`)
 * to transparently reconnect to a shell that survived a WebSocket keepalive drop.
 *
 * This listing is only ever used to VERIFY an id we already hold authoritatively
 * (from {@link readSessionInfoId}) — never to guess which of a Sprite's shells is
 * "ours". `isActive` is the SDK's mapping of the API's `is_active`, whose exact
 * meaning (process-alive vs client-attached) the docs do not specify; nothing
 * selects a session by it.
 */
export interface SpriteSessionInfo {
  id: string;
  command: string;
  isActive: boolean;
  /**
   * OPTIONAL, and not to be trusted for identity. The raw API does return
   * `tty` for a TTY session, but the SDK only sometimes surfaces it: the pinned
   * rc37 maps it, while the published 0.0.1 build dropped `tty` (and `workdir`)
   * from its `listSessions()` mapping entirely. Code that FILTERS on it silently
   * matches nothing after an SDK bump, so treat its absence as "unknown", never
   * as "not a shell", and identify sessions by id (see {@link readSessionInfoId}).
   */
  tty?: boolean;
}

/**
 * The id of the exec session a command handle is bound to, read from the
 * `session_info` control frame the server sends on that session's OWN socket
 * immediately after it opens (API: WSS `/v1/sprites/{name}/exec` →
 * `{"type":"session_info","session_id":…,"command":…,"tty":…}`; the SDK
 * JSON-parses it and re-emits it as the command's `message` event).
 *
 * This is the authoritative, race-free source of a freshly created session's id:
 * the frame arrives on the very socket `createSession()` returned, so N concurrent
 * creates on ONE Sprite each learn their own id and cannot be mis-attributed. It
 * replaces the old before/after `listSessions()` diffing, which could not tell a
 * sibling terminal's new shell from ours and therefore had to abstain (persisting
 * nothing) exactly when the Sprite was busiest.
 *
 * Returns undefined for any other frame (port notifications, resize acks, raw
 * text) and for a malformed/absent id — the RC SDK ships no typed frame union, so
 * this validates the wire shape defensively rather than trusting it.
 */
export function readSessionInfoId(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const frame = message as { type?: unknown; session_id?: unknown };
  if (frame.type !== 'session_info') return undefined;
  return typeof frame.session_id === 'string' && frame.session_id.length > 0
    ? frame.session_id
    : undefined;
}

/** The Sprite instance subset the driver consumes. */
export interface SpriteInstanceLike {
  readonly name: string;
  spawn(
    file: string,
    args?: string[],
    options?: SpriteSpawnOptions,
  ): SpriteCommandLike;
  /**
   * Start a detachable session (the SDK forces `tty: true`). A TTY session has
   * `max_run_after_disconnect: 0` server-side — it keeps running indefinitely
   * after the client WebSocket drops — which is the basis for a persistent
   * interactive terminal that survives keepalive timeouts and reconnects.
   */
  createSession(
    command: string,
    args?: string[],
    options?: SpriteSpawnOptions,
  ): SpriteCommandLike;
  /**
   * Reattach to an existing session by id (connects to WSS `/exec/{id}`); the
   * server immediately replays the session's scrollback buffer as stdout.
   */
  attachSession(sessionId: string, options?: SpriteSpawnOptions): SpriteCommandLike;
  /** List the Sprite's exec sessions (the source of truth for reattach). */
  listSessions(): Promise<SpriteSessionInfo[]>;
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
 * Resolve the Sprites API token. Returns '' (→ the SDK's calls fail-closed with
 * an auth error, surfaced as a provisioning failure) when unset, so a missing
 * token disables execution instead of crashing the app.
 *
 * Read directly from `process.env`, NOT via `getValidatedEnv()`: the token is
 * resolved in the realtime service too (terminal PTY), whose lean env does not
 * satisfy the full web schema — `getValidatedEnv()` would throw there, blanking
 * the token and breaking terminals even when it is set.
 */
export function resolveSpritesToken(): string {
  return process.env.SPRITES_API_TOKEN ?? '';
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

    // The SDK emits 'spawn' exactly when `start()` resolves — i.e. the socket is
    // open (and, for an attach, `session_info` has arrived). It is therefore the
    // authoritative boundary between "this never ran" and "this may have run",
    // which is the only question the retry needs answered. See `isPreOpenWakeError`
    // for why the error's TEXT cannot answer it.
    let opened = false;
    command.on('spawn', () => {
      opened = true;
    });

    command.stdout.on('data', (chunk) => {
      // Output proves the connection opened, even if the 'spawn' event was missed.
      opened = true;
      stdoutLen = collect(stdoutChunks, chunk, stdoutLen);
    });
    command.stderr.on('data', (chunk) => {
      opened = true;
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
      // A failure BEFORE the socket opened never started the command, so it is
      // safe to re-run. One that arrives after may already have run it, and must
      // not be.
      fail(opened ? error : markPreOpenDrop(error));
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

// Cold-start exec retry. A hibernated Sprite has NO explicit wake API — an
// incoming request to it (i.e. any exec) wakes it automatically
// (docs.sprites.dev/concepts/lifecycle), so the FIRST REAL operation is the
// wake. Fly's wake-on-request can drop that first connection while the VM boots.
// Such a failure is provably PRE-OPEN (the command never started), so retrying it
// is safe and IS the wake handshake — see `isPreOpenWakeError` for how that is
// detected (structurally, from the absence of the SDK's `spawn` event; the error's
// text cannot be trusted for it). We retry ONLY that signal: a post-open failure
// (timeout, output overflow, non-zero exit, mid-command socket drop) may have
// already run the command and must NOT be retried.
export const MAX_EXEC_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 500;
const FS_OP_TIMEOUT_MS = 30_000;

/**
 * Marks an error that reached us BEFORE the command's socket opened.
 *
 * This is a STRUCTURAL fact, recorded by whoever was watching the connection, not
 * a guess made afterwards from the error's text. The distinction matters because
 * the text is not usable: `@fly/sprites` has no `ws` dependency — it drives the
 * global (undici) WebSocket, whose own file header notes that "the standard
 * WebSocket API does not expose HTTP error responses on connection failure". On a
 * failed handshake undici fires `error` BEFORE `close`, and the SDK registers its
 * `error` listener first (websocket.js), so the first thing a consumer sees is
 * `WebSocket error: <opaque>` — NOT the `WebSocket closed before open: …` string
 * that only gets emitted afterwards, from the `close` listener. Matching on that
 * string alone therefore misses the very cold-start drop it was written for.
 *
 * Non-enumerable and symbol-keyed so marking never alters an error's identity,
 * message, or JSON shape — callers still see exactly the error the SDK threw.
 */
const PRE_OPEN_DROP = Symbol.for('pagespace.sandbox.preOpenDrop');

function markPreOpenDrop(error: unknown): unknown {
  if (typeof error === 'object' && error !== null) {
    Object.defineProperty(error, PRE_OPEN_DROP, { value: true, enumerable: false, configurable: true });
  }
  return error;
}

/**
 * Pure: is this failure a drop that happened BEFORE the connection opened (and so
 * provably never ran the command, making a re-run safe)?
 *
 * Answers structurally: a failure observed while still waiting for the SDK's
 * `spawn` event — which fires exactly when `start()` resolves — never ran the
 * command. Every pre-open failure is marked at the point it is observed, so
 * production relies on the mark alone.
 *
 * The `closed before open` text check below is a DEFENSIVE fallback, not a
 * load-bearing one: the SDK emits that string as an `error` event inside the
 * pre-open window too, so it is already marked structurally by the time anyone
 * asks. It survives only to classify an error that reached a caller without
 * having been observed pre-open (a hand-constructed one, or a future SDK that
 * stops emitting `spawn`). Do not add new signals here — mark at the source.
 *
 * A timeout or an output overflow is never retryable: the command may already
 * have run.
 */
export function isPreOpenWakeError(error: unknown): boolean {
  if (error instanceof SandboxCommandTimeoutError || error instanceof SandboxOutputLimitError) {
    return false;
  }
  if (typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[PRE_OPEN_DROP] === true) {
    return true;
  }
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return msg.includes('closed before open');
}

/** Record that `error` reached the caller before the connection ever opened. */
export function asPreOpenDrop(error: unknown): unknown {
  return markPreOpenDrop(error);
}

/** Pure: the linear backoff between wake attempts (attempt is 1-based). */
export function wakeRetryDelayMs(attempt: number, baseDelayMs: number = RETRY_BASE_DELAY_MS): number {
  return baseDelayMs * attempt;
}

export type WakeRetryPlan = { retry: true; delayMs: number } | { retry: false };

/**
 * Pure: after `attempt` (1-based) failed with `error`, should the operation be
 * re-run, and after how long? Bounded by `maxAttempts` so a Sprite that never
 * wakes surfaces its error instead of looping forever.
 */
export function planWakeRetry({
  error,
  attempt,
  maxAttempts = MAX_EXEC_ATTEMPTS,
  baseDelayMs = RETRY_BASE_DELAY_MS,
}: {
  error: unknown;
  attempt: number;
  maxAttempts?: number;
  baseDelayMs?: number;
}): WakeRetryPlan {
  if (!isPreOpenWakeError(error)) return { retry: false };
  if (attempt >= maxAttempts) return { retry: false };
  return { retry: true, delayMs: wakeRetryDelayMs(attempt, baseDelayMs) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WakeRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Injected so the schedule can be asserted without real timers. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The retry executor: a thin shell around the pure `planWakeRetry` schedule that
 * re-runs an INJECTED operation on the cold-start wake handshake. `op` is a
 * factory, not a promise — each attempt must open a FRESH connection (a settled
 * promise cannot be retried).
 */
export async function withWakeRetry<T>(
  op: (attempt: number) => Promise<T>,
  { maxAttempts = MAX_EXEC_ATTEMPTS, baseDelayMs = RETRY_BASE_DELAY_MS, sleep = delay }: WakeRetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await op(attempt);
    } catch (error) {
      const plan = planWakeRetry({ error, attempt, maxAttempts, baseDelayMs });
      if (!plan.retry) throw error;
      await sleep(plan.delayMs);
    }
  }
}

/**
 * Spawn + collect with the bounded cold-start wake retry. The command is
 * (re-)spawned per attempt via `spawnFn` so each retry opens a fresh WebSocket.
 */
function runSpawnedWithWakeRetry(
  spawnFn: () => SpriteCommandLike,
  maxBytes: number,
  timeoutMs: number | undefined,
): Promise<SandboxRunResult> {
  return withWakeRetry(() => runSpawned(spawnFn(), maxBytes, timeoutMs));
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

/**
 * Force a hibernated VM awake via a cheap no-op exec, with the same bounded
 * cold-start retry as a real command.
 *
 * THE FILESYSTEM PATH IS THE ONLY LEGITIMATE CALLER, and deliberately not
 * exported. Every OTHER operation already wakes the VM by itself: a Sprite has
 * no explicit wake API — an incoming request wakes it automatically
 * (docs.sprites.dev/concepts/lifecycle) — so an exec, a `createSession` or an
 * `attachSession` IS the wake, and prefixing one with a `sh -c :` just pays for
 * two cold starts instead of one.
 *
 * The Sprite filesystem HTTP API is the exception, and the reason this still
 * exists: it is a bare `fetch()` with no AbortSignal that does NOT wake a
 * hibernated VM — it simply hangs (52–90s observed) until Fly's proxy closes the
 * connection. So an fs op against a cold Sprite has no way to wake the VM it is
 * waiting on. This exec does it for it.
 */
async function wakeSpriteViaExec(sprite: SpriteInstanceLike): Promise<void> {
  await runSpawnedWithWakeRetry(
    () => sprite.spawn('sh', ['-c', ':']),
    DEFAULT_MAX_OUTPUT_BYTES,
    FS_OP_TIMEOUT_MS,
  );
}

/**
 * Run a filesystem op bounded by a timeout; on the first failure (cold-start
 * hang/race) wake the VM via the exec path and retry once — see
 * `wakeSpriteViaExec` for why the fs API cannot wake the VM itself.
 */
async function fsWithWakeRetry<T>(
  sprite: SpriteInstanceLike,
  label: string,
  op: () => Promise<T>,
): Promise<T> {
  try {
    return await withTimeout(op(), FS_OP_TIMEOUT_MS, label);
  } catch {
    await wakeSpriteViaExec(sprite);
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
      //
      // Self-healing cwd: when a cwd is given, don't hand it to spawn as an
      // immutable precondition (a deleted cwd makes spawn fail outright — an agent
      // that `rm -rf`s `/workspace` would otherwise brick the sandbox for the rest
      // of the conversation). Instead route through a tiny `sh` wrapper that
      // recreates + enters the cwd first, so it self-heals on the next command.
      // cwd/cmd/args are passed as positional DATA args (`$1`=cwd; `shift` drops it
      // so `"$@"` = cmd args…; `exec` preserves the real exit code) — never
      // interpolated into the script, preserving the arg-array no-injection
      // invariant. With no cwd, spawn directly as before.
      const spawnFn = cwd === undefined
        ? () => sprite.spawn(cmd, args, { env })
        : () => sprite.spawn(
            'sh',
            ['-c', 'mkdir -p "$1" 2>/dev/null; cd "$1" || exit 1; shift; exec "$@"', 'sh', cwd, cmd, ...args],
            { env },
          );
      return runSpawnedWithWakeRetry(spawnFn, maxBytes ?? 0, timeoutMs);
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
// Called only when the policy is NOT already known-good on this Sprite (fresh
// create, hash mismatch, or unknown recorded state — see `shouldApplyPolicy`), so
// a Sprite is never returned with open/unknown egress and a warm resume pays no
// redundant control-plane round-trip. When `destroyOnFailure` is set (a FRESH
// create), a lockdown failure destroys the just-created Sprite before
// propagating; on a resumed Sprite we never destroy a warm session, but the error
// still propagates so the caller refuses to hand back a Sprite without a
// confirmed policy.
async function applyEgressLockdown({
  sdk,
  sprite,
  policy,
  destroyOnFailure,
}: {
  sdk: SpritesSdk;
  sprite: SpriteInstanceLike;
  policy: NetworkPolicy;
  destroyOnFailure: boolean;
}): Promise<void> {
  try {
    await sprite.updateNetworkPolicy(policy);
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

/**
 * Wrap an SDK so every `getSprite` for the same name within this wrapper's
 * lifetime resolves ONE underlying read, memoized by name.
 *
 * A single cold terminal connect used to read the same Sprite up to three times:
 * once inside `getOrCreate` (the resume probe), once to wake it, and once more
 * to hand the raw instance to the PTY layer. A `getSprite` is a control-plane
 * round-trip, so those were two avoidable network hops on the SLOWEST path we
 * have. Build ONE cache per connect and thread it through the whole resolution
 * (acquire -> auth -> launch) and the Sprite is read exactly once.
 *
 * Two details make the memo safe rather than merely fast:
 *  - A REJECTION is never cached. `getOrCreate`'s create path *expects*
 *    `getSprite` to reject (not-found) before it calls `createSprite`; caching
 *    that rejection would make every later read of the name fail forever. A
 *    transient 429/5xx is evicted for the same reason — a retry must be a real
 *    retry.
 *  - `createSprite` SEEDS the cache and `deleteSprite` EVICTS it, so the fresh
 *    path needs no second read to see its own Sprite, and a destroyed one is
 *    never served from cache.
 *
 * Scope it to one request/connect, never to the process: the handle is a live
 * control-plane object, and a process-lifetime cache would pin a Sprite that has
 * since been destroyed and re-created under the same name.
 */
export function createSpriteHandleCache(sdk: SpritesSdk): SpritesSdk {
  const handles = new Map<string, Promise<SpriteInstanceLike>>();

  return {
    getSprite(name) {
      const cached = handles.get(name);
      if (cached) return cached;

      const pending = sdk.getSprite(name);
      handles.set(name, pending);
      pending.catch(() => {
        // Evict, don't memoize a failure — see the doc above. Guarded so a late
        // rejection can't evict a handle a subsequent create already seeded.
        if (handles.get(name) === pending) handles.delete(name);
      });
      return pending;
    },

    async createSprite(name, config) {
      const sprite = await sdk.createSprite(name, config);
      handles.set(name, Promise.resolve(sprite));
      return sprite;
    },

    async deleteSprite(name) {
      handles.delete(name);
      await sdk.deleteSprite(name);
    },
  };
}

export function createSpritesSandboxClient({ sdk }: { sdk: SpritesSdk }): ExecSandboxClient {
  return {
    async getOrCreate({ name, options, appliedPolicyHash }) {
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
        // Lock down egress only when it is not already known-good on this Sprite
        // (fresh create / changed policy / unknown recorded state) — see file
        // header and `../egress-lockdown.ts`. A warm resume under the same policy
        // skips the control-plane round-trip and the `mkdir` exec entirely: the
        // policy file and the sandbox root are both persistent.
        const policy = buildSpriteNetworkPolicy({
          egressAllowlist: options.egressAllowlist,
          egressMode: options.egressMode,
        });
        if (shouldApplyPolicy({ fresh, appliedPolicyHash, desiredPolicyHash: hashPolicy(policy) })) {
          await applyEgressLockdown({ sdk, sprite, policy, destroyOnFailure: fresh });
        }
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
      // We do NOT reapply egress here: the policy persists across hibernation
      // (the platform's configure-once model), and a dropped first wake is
      // recovered by runCommand's cold-start retry.
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
