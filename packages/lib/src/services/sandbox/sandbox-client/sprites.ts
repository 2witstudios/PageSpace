/**
 * Fly Sprites driver (IO) for the provider-neutral `ExecSandboxClient` seam.
 *
 * Implements PR2's `SandboxClient` lifecycle (getOrCreate / get / stop) and the
 * PR3 execution surface (runCommand / writeFiles / readFileToBuffer) against
 * `@fly/sprites`. A Sprite is named by the conversation session key, so
 * `getOrCreate` resumes an existing Sprite by name or creates a fresh one.
 *
 * Provisioning is locked down, never platform defaults:
 *  - **Egress** — the deny-by-default L3 network policy is applied whenever THIS
 *    VM is not already PROVEN to be running THIS policy: on a FRESH create (a new
 *    Sprite starts with the platform's open outbound), on a changed policy, on a
 *    Sprite re-created under the same name (a different VM instance, whose
 *    predecessor's proof must not carry over), and when the caller records no
 *    proof at all (unknown → fail closed). Only a warm resume of the same VM under
 *    the same policy skips it: the policy is a persistent file
 *    (`/.sprite/policy/network.json`) that survives hibernation, so re-pushing it
 *    on every hand-back was pure chatter on the connect critical path. The proof
 *    is a token over (Sprite instance id, policy hash) — see
 *    `../egress-lockdown.ts`. The crash window the old unconditional re-apply
 *    defended (a crash between `createSprite` and its lockdown) is closed by
 *    ORDERING instead: the caller links the session only after `getOrCreate`
 *    resolves, so an unlocked Sprite is never reachable from a session row —
 *    whether or not it is ever destroyed. A lockdown failure RETAINS and retries
 *    the Sprite inline (with backoff) rather than destroying it on the first
 *    flake; a RESUMED Sprite is never destroyed no matter how many failures (it
 *    already has a session row a user can act on), while a FRESH one that
 *    exhausts its bounded retry budget IS destroyed, so a genuinely broken VM
 *    doesn't poison its session key forever with no persisted row to act on —
 *    see `planProvisionFailure`. The call always rejects on a failure so no
 *    command runs without a confirmed policy.
 *  - **Caps** — RAM / vCPUs / storage / region come from the resolved policy
 *    (`SpriteConfig`), set explicitly per Sprite rather than relying on the quota
 *    defaults.
 *  - **No secrets** — the allowlisted env is set by the caller via
 *    `buildSandboxEnv`; this driver injects none. v1 brokers no outbound
 *    credentials (a Fly Tokenizer proxy is the future path, out of scope).
 *
 * `stop` is a USER-INITIATED, irreversible DESTROY — files, installed packages,
 * and checkpoints are all gone with no undo (docs.sprites.dev/working-with-sprites).
 * Call it only for genuine teardown intent (a Machine/branch delete, or cleaning
 * up a Sprite this process just failed to link to a session row) — never as
 * idle/billing cleanup: a paused Sprite already stops compute billing on its own
 * and costs only bytes-written storage, so idleness alone is never a reason to
 * destroy one (docs.sprites.dev/concepts/lifecycle).
 *
 * The SDK's promise-based `exec`/`execFile` expose neither a per-command timeout
 * nor a handle to abort a running command, so the run is driven through `spawn`
 * — which takes the same `(file, args[])` structured form (NO host-side shell
 * string) and returns a `SpriteCommand` we can `kill('SIGKILL')`. We replicate
 * the SDK's own `execFile` stream collection (stdout/stderr `data` listeners,
 * `maxBuffer` cap, `exit` event) and add a HARD wall-clock timer that SIGKILLs
 * the command on expiry. The command, not the Sprite, is killed — the warm
 * conversation session survives a single slow run; if the conversation goes
 * quiet afterward, the Sprite simply hibernates on its own (the platform's idle
 * pause), never destructively reclaimed.
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
import { hashPolicy, egressLockdownToken, shouldApplyPolicy } from '../egress-lockdown';
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

/**
 * Pure: the `(file, args[])` to spawn `command` with a SELF-HEALING working
 * directory, instead of handing `cwd` to the SDK as an immutable precondition.
 *
 * The server `chdir`s into `cwd` before spawning, so a missing directory fails
 * the spawn outright — and `SANDBOX_ROOT` is persistent but NOT immutable: an
 * agent that `rm -rf`s `/workspace` would otherwise brick every later command
 * and every later PTY open. So route through a tiny `sh` that recreates + enters
 * the directory and then `exec`s the real command (`exec` preserves the PTY, the
 * signals, and the real exit code).
 *
 * cwd/command/args are passed as positional DATA args (`$0`=sh, `$1`=cwd;
 * `shift` drops it so `"$@"` is the command and its args) — never interpolated
 * into the script — so the no-shell-injection invariant of the arg-array form
 * holds even for a cwd full of shell metacharacters.
 *
 * This is the one place that self-heal is defined: the batch path
 * ({@link wrap}'s `runCommand`), the `MachineHost` PTY (`sprite-machine-host`),
 * and the realtime terminal (`apps/realtime/src/terminal/sprites-shell.ts`) all
 * spawn through it. It is also why the egress lockdown's `mkdir` no longer needs
 * to run on every hand-back — see `../egress-lockdown.ts`.
 */
export function spawnWithSelfHealingCwd({
  command,
  args = [],
  cwd,
}: {
  command: string;
  args?: readonly string[];
  cwd: string;
}): [string, string[]] {
  return [
    'sh',
    ['-c', 'mkdir -p "$1" 2>/dev/null; cd "$1" || exit 1; shift; exec "$@"', 'sh', cwd, command, ...args],
  ];
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

/**
 * The subset of the SDK's checkpoint/restore progress stream the driver
 * consumes — mirrors the real `CheckpointStream`/`RestoreStream` (both expose
 * `processAll`). Messages are `{type: 'info'|'stdout'|'stderr'|'error', data?,
 * error?}`; see {@link checkpointStreamErrorMessage} for how an `error`-type
 * message is surfaced as a rejection.
 */
export interface SpriteCheckpointStreamMessage {
  type: string;
  data?: string;
  error?: string;
}

export interface SpriteCheckpointStreamLike {
  processAll(handler: (message: SpriteCheckpointStreamMessage) => void | Promise<void>): Promise<void>;
  /** Close the stream — called on a timeout so a stalled read doesn't hold the
   *  underlying connection open past the point we've given up waiting on it. */
  close(): void;
}

/** The Sprite instance subset the driver consumes. */
export interface SpriteInstanceLike {
  readonly name: string;
  /**
   * The platform's id for this Sprite INSTANCE, hydrated from the API response by
   * both `getSprite` and `createSprite` (the SDK `Object.assign`s the parsed body
   * onto the handle), so reading it costs nothing extra.
   *
   * Distinct from `name`, which is OURS and is reused across re-creates: a Sprite
   * destroyed and re-provisioned under the same session key is a different VM,
   * with a different id — and, crucially, with the platform's default OPEN egress
   * until it is locked down. The egress record is therefore keyed on this id, not
   * on the name (see `../egress-lockdown.ts`).
   *
   * Optional because the RC SDK types it optional: a build that stops reporting it
   * must degrade to "identity unknown" → re-apply the lockdown, never to "same
   * Sprite, skip it".
   */
  readonly id?: string;
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
  /**
   * Create a checkpoint of the writable filesystem overlay, tagged with an
   * optional `comment` (docs.sprites.dev/concepts/checkpoints — copy-on-write,
   * ~300ms, does not interrupt the Sprite). Returns a progress stream; the
   * driver drains it to completion and surfaces any `error`-type message as a
   * rejection — see {@link checkpointStreamErrorMessage}.
   */
  createCheckpoint(comment?: string): Promise<SpriteCheckpointStreamLike>;
  destroy(): Promise<void>;
  /**
   * Terminate a specific exec session server-side via `POST
   * /v1/sprites/{name}/exec/{session_id}/kill` (sprites.dev/api) — see
   * {@link killSpriteSession} for the driver. Unlike `SpriteCommandLike.kill()`
   * (a signal delivered over that command's OWN WebSocket, which reaches the
   * remote process only while that socket happens to be open — see
   * `sprite-machine-host.ts`'s note on the private, unreachable
   * `WSCommand.close()`), this reaches a session regardless of whether we hold
   * a live connection to it: a detachable TTY session has
   * `max_run_after_disconnect: 0` and keeps running server-side long after its
   * client socket has dropped, which is exactly the case a stale local `kill()`
   * silently no-ops on.
   *
   * MUST be idempotent: killing an id the Sprite no longer recognizes (already
   * dead, or never existed) resolves successfully rather than rejecting, so a
   * caller never surfaces a user-visible failure for a session that is already
   * gone — see {@link killSpriteSession}.
   */
  killSession(sessionId: string): Promise<void>;
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
 *
 * Exported for the sprite-tasks hold client (`./sprite-tasks.ts`), which runs
 * one-shot curl execs against the in-sprite management socket and needs
 * exactly this collect-bounded-output-or-kill contract — WITHOUT
 * `withWakeRetry` (a hold call must never wake a paused sprite; the pre-open
 * marking below is inert unless that wrapper is applied).
 */
export function runSpawned(
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
          // Best-effort kill; if the signal is dropped, the run's own wall-clock
          // timeout (when set) or the Sprite's own idle hibernation is the
          // eventual backstop — there is no separate reaper.
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
          // Best-effort; if SIGKILL is dropped, the Sprite's own idle
          // hibernation is the eventual backstop — there is no separate reaper.
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
 * Pure: the directory a Sprite path lives in.
 *
 * Deliberately NOT `node:path.dirname`: these are paths inside the Sprite's
 * Linux VM, and on a Windows host `path.dirname` would apply Win32 semantics
 * (backslash separators, drive letters) to them. POSIX by construction, so the
 * answer never depends on where the server happens to run. A path with no `/`,
 * or one directly under the root, yields `/`.
 */
export function parentDir(filePath: string): string {
  const cut = filePath.lastIndexOf('/');
  return cut <= 0 ? '/' : filePath.slice(0, cut);
}

/**
 * Pure: the recovery exec run between a failed filesystem op and its retry.
 *
 * With no directories it is a bare no-op (`sh -c :`) whose only job is to WAKE
 * the VM; with directories it also `mkdir -p`s them, so the one exec does double
 * duty — see {@link recoverFsViaExec}. The directories are positional DATA args
 * (`"$@"`), never interpolated into the script, so a path full of shell
 * metacharacters cannot escape into the command.
 */
export function fsRecoveryExec(ensureDirs: readonly string[] = []): [string, string[]] {
  return ensureDirs.length === 0
    ? ['sh', ['-c', ':']]
    : ['sh', ['-c', 'mkdir -p "$@" 2>/dev/null || :', 'sh', ...ensureDirs]];
}

/**
 * Recover a failed filesystem op with a single exec: wake the VM, and recreate
 * any directories the op needs.
 *
 * THE FILESYSTEM PATH IS THE ONLY LEGITIMATE CALLER, and deliberately not
 * exported. Every OTHER operation already wakes the VM by itself: a Sprite has
 * no explicit wake API — an incoming request wakes it automatically
 * (docs.sprites.dev/concepts/lifecycle) — so an exec, a `createSession` or an
 * `attachSession` IS the wake, and prefixing one with a `sh -c :` just pays for
 * two cold starts instead of one.
 *
 * The Sprite filesystem HTTP API is the exception, and the reason this exists:
 * it is a bare `fetch()` with no AbortSignal that does NOT wake a hibernated VM
 * — it simply hangs (52–90s observed) until Fly's proxy closes the connection.
 * So an fs op against a cold Sprite has no way to wake the VM it is waiting on.
 * This exec does it for it.
 *
 * A write ALSO fails when its parent directory is gone — the fs API does not
 * create parents, and SANDBOX_ROOT is persistent but not immutable (a sandbox
 * command can `rm -rf /workspace`). That used to be papered over by the egress
 * lockdown's `mkdir` running on every hand-back; now that the lockdown is
 * fresh-create-only (`../egress-lockdown.ts`), the write self-heals here instead
 * — folded into the wake exec it was already paying for, so the happy path costs
 * nothing extra.
 */
async function recoverFsViaExec(sprite: SpriteInstanceLike, ensureDirs: readonly string[] = []): Promise<void> {
  await runSpawnedWithWakeRetry(
    () => sprite.spawn(...fsRecoveryExec(ensureDirs)),
    DEFAULT_MAX_OUTPUT_BYTES,
    FS_OP_TIMEOUT_MS,
  );
}

/**
 * Run a filesystem op bounded by a timeout; on the first failure (cold-start
 * hang/race, or a missing parent directory) recover via the exec path and retry
 * once — see `recoverFsViaExec` for why the fs API can do neither itself.
 */
async function fsWithWakeRetry<T>(
  sprite: SpriteInstanceLike,
  label: string,
  op: () => Promise<T>,
  ensureDirs: readonly string[] = [],
): Promise<T> {
  try {
    return await withTimeout(op(), FS_OP_TIMEOUT_MS, label);
  } catch {
    await recoverFsViaExec(sprite, ensureDirs);
    return await withTimeout(op(), FS_OP_TIMEOUT_MS, label);
  }
}

/**
 * Pure: extract the failure text from a checkpoint/restore stream `message`, or
 * undefined if it isn't an `error`-type message. `error` is preferred over
 * `data` (the SDK types `data` as the general payload field and `error` as the
 * specific failure text when present); a message that types itself `error` but
 * carries neither falls back to a generic string so a rejection is never
 * empty.
 */
export function checkpointStreamErrorMessage(message: SpriteCheckpointStreamMessage): string | undefined {
  if (message.type !== 'error') return undefined;
  return message.error ?? message.data ?? 'checkpoint stream reported an error';
}

/**
 * Wall-clock cap on `ExecutableSandbox.createCheckpoint` (the `createCheckpoint`
 * call plus draining its stream). The SDK exposes no timeout or abort handle
 * for either step, so this driver enforces one itself — see the call site's
 * doc for why a bound is needed here in addition to the shell's own (P2
 * review finding, PR #2025).
 */
const CHECKPOINT_TIMEOUT_MS = 10_000;

/**
 * The HTTP credentials `killSpriteSession` needs — deliberately narrow (not
 * the whole `SpritesClient`) so production wiring (`apps/web/.../sprites-client.ts`,
 * `apps/realtime/.../realtime-sprites-client.ts`) can pass the real client's
 * public `baseURL`/`token` fields without this module importing `@fly/sprites`
 * (it stays a pure-logic/type-safe-wrapper module — see the file header).
 */
export interface SpriteSessionKillTransport {
  baseURL: string;
  token: string;
  /** Injected so a test can assert the exact request without a real network call. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected so a test can assert the retry schedule without real wall-clock waits. Defaults to the real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wall-clock cap on `killSpriteSession` (the request plus draining its
 * response stream — see below). A bare `fetch` has no timeout of its own, and
 * every other network call this driver makes is bounded (filesystem ops via
 * `withTimeout`, checkpoints via `CHECKPOINT_TIMEOUT_MS`), so an unbounded
 * kill call would be the one exception that can hang a caller forever against
 * a stalled connection.
 */
const KILL_SESSION_TIMEOUT_MS = 10_000;

/**
 * Pure: does this line of the kill endpoint's NDJSON progress stream report a
 * failure? Returns the failure text for a `{"type":"error",...}` line, or
 * undefined for every other documented event (`signal`/`timeout`/`exited`/
 * `killed`/`complete`) and for a blank or unparseable line — a malformed
 * progress line must never mask an otherwise-successful kill.
 */
export function killSessionStreamErrorMessage(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof event !== 'object' || event === null) return undefined;
  const { type, message } = event as { type?: unknown; message?: unknown };
  if (type !== 'error') return undefined;
  return typeof message === 'string' && message.length > 0 ? message : 'session kill reported an error';
}

/**
 * One attempt at the documented Sprites REST endpoint the `@fly/sprites` SDK
 * (rc37) does not wrap: `POST /v1/sprites/{name}/exec/{session_id}/kill`
 * (sprites.dev/api/sprites/exec#kill-exec-session — NOT
 * `.../exec/sessions/{id}/kill`; the extra `sessions/` segment 404s against
 * the real API). `Sprite` exposes `attachSession`/`createSession`/`kill()`
 * (a per-command WebSocket signal) but no session-kill-by-id, so this hits the
 * endpoint directly — `baseURL` and `token` are public `readonly` fields on the
 * real `SpritesClient`, reachable off any `Sprite` instance's own `.client`.
 *
 * A success response is `200` with a STREAMING NDJSON body (`signal` ->
 * `exited`/`killed` -> `complete`, or a `type: 'error'` line if the signal
 * could not actually be delivered) — the HTTP status alone does not confirm
 * the session was killed, only that the request was accepted. So a `200` is
 * drained and checked line-by-line via {@link killSessionStreamErrorMessage};
 * only a stream with no `error` line resolves.
 *
 * `404`/`410` means the Sprite no longer recognizes this session id (the
 * documented response for a missing session/sprite) — that IS success, not a
 * failure: the caller's whole reason for calling is "make sure this session
 * is dead," and it already is. Idempotent by construction, so a kill racing
 * (or arriving after) another kill, a natural process exit, or a Sprite-level
 * destroy never surfaces a user-visible error. Any other non-2xx response, or
 * an `error` line inside a 200 stream, is a genuine failure and rejects.
 */
async function attemptKillSpriteSession(
  { baseURL, token, fetchImpl = fetch }: SpriteSessionKillTransport,
  spriteName: string,
  sessionId: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KILL_SESSION_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `${baseURL}/v1/sprites/${encodeURIComponent(spriteName)}/exec/${encodeURIComponent(sessionId)}/kill`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
    );
    if (!response.ok) {
      if (response.status === 404 || response.status === 410) return;
      throw new Error(`Sprite session kill failed: ${response.status} ${response.statusText}`);
    }
    const body = await response.text();
    for (const line of body.split('\n')) {
      const errorMessage = killSessionStreamErrorMessage(line);
      if (errorMessage !== undefined) {
        throw new Error(`Sprite session kill reported an error: ${errorMessage}`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * {@link attemptKillSpriteSession}, retried up to `MAX_EXEC_ATTEMPTS` times
 * with the same linear backoff `withWakeRetry` uses (`wakeRetryDelayMs`).
 *
 * Deliberately retries on ANY failure, not just a structurally-detected
 * pre-open drop the way the exec/spawn paths in this file do. Those paths
 * must retry ONLY a provable pre-open failure, because re-running a
 * side-effecting command after an ambiguous one risks running it twice. A
 * kill has no such hazard — it is idempotent by construction (see the
 * `404`/`410` handling above) — so repeating it after ANY failure, including
 * the exact cold-Sprite wake-on-request connection drop the exec paths guard
 * against (docs.sprites.dev/concepts/lifecycle: there is no wake API, so this
 * REST call may itself be what wakes a hibernating Sprite), costs nothing and
 * only improves the odds a genuine termination actually lands. This is the
 * caller-visible guarantee: `killAgentTerminal`'s `MachineHandle.killSession`
 * and `PtyShell.kill`'s fire-and-forget REST call both inherit it for free,
 * without either needing its own retry logic.
 */
export async function killSpriteSession(
  transport: SpriteSessionKillTransport,
  spriteName: string,
  sessionId: string,
): Promise<void> {
  const { sleep = delay } = transport;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_EXEC_ATTEMPTS; attempt += 1) {
    try {
      await attemptKillSpriteSession(transport, spriteName, sessionId);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_EXEC_ATTEMPTS) break;
      await sleep(wakeRetryDelayMs(attempt));
    }
  }
  throw lastError;
}

/**
 * Bolt `killSession` onto a raw SDK `Sprite`-shaped instance, so it satisfies
 * `SpriteInstanceLike` — see {@link killSpriteSession}'s doc for why the SDK
 * needs this at all. Shared by BOTH production `SpritesSdk` factories
 * (`apps/web/src/lib/sandbox/sprites-client.ts`,
 * `apps/realtime/src/terminal/realtime-sprites-client.ts`) — this used to be
 * defined twice, near-verbatim, one per app boundary. Duck-typed (not
 * `import type { Sprite } from '@fly/sprites'`) so this module never imports
 * the ESM-only SDK (see the file header); a real `Sprite` instance already
 * satisfies this shape structurally, and `client.baseURL`/`client.token` are
 * public `readonly` fields on the real `SpritesClient`.
 *
 * Mutates and returns `sprite` (via `Object.assign`) rather than building a
 * fresh wrapper object, so every OTHER method the caller already relies on
 * (`spawn`, `createSession`, `attachSession`, `filesystem`, …) keeps working
 * untouched — this only ever ADDS the one method the SDK is missing.
 */
export function withKillSession<T extends { name: string; client: { baseURL: string; token: string } }>(
  sprite: T,
): T & { killSession: (sessionId: string) => Promise<void> } {
  return Object.assign(sprite, {
    killSession: (sessionId: string) =>
      killSpriteSession({ baseURL: sprite.client.baseURL, token: sprite.client.token }, sprite.name, sessionId),
  });
}

function wrap(sprite: SpriteInstanceLike, egressPolicyToken?: string): ExecutableSandbox {
  return {
    sandboxId: sprite.name,
    // Proof of THIS VM's confirmed lockdown, for the caller to persist. Undefined
    // on the `get` path (which applies no policy) and whenever the Sprite's
    // identity is unknown — both of which the caller must treat as "unproven".
    egressPolicyToken,

    async runCommand({ cmd, args = [], cwd, env, timeoutMs, maxBytes }: RunCommandArgs): Promise<SandboxRunResult> {
      // spawn (arg array), never a host-side shell string. The untrusted command
      // runs under the Sprite's own `sh -c`, contained by the VM. Re-spawned per
      // attempt so a cold-start wake drop reconnects on a fresh WebSocket.
      //
      // Self-healing cwd (see `spawnWithSelfHealingCwd`): a given cwd is never a
      // precondition — the wrapper recreates and enters it. With no cwd, spawn
      // directly as before.
      const spawnFn = cwd === undefined
        ? () => sprite.spawn(cmd, args, { env })
        : () => sprite.spawn(...spawnWithSelfHealingCwd({ command: cmd, args, cwd }), { env });
      return runSpawnedWithWakeRetry(spawnFn, maxBytes ?? 0, timeoutMs);
    },

    async writeFiles(files: WriteFileEntry[]): Promise<void> {
      const fs = sprite.filesystem('/');
      for (const file of files) {
        const data = typeof file.content === 'string' ? file.content : Buffer.from(file.content);
        // Bounded + recover-on-failure: the fs API hangs on a hibernated VM, and
        // it does not create parent directories — so the retry's exec both wakes
        // the VM and recreates this file's parent (self-healing SANDBOX_ROOT,
        // which a sandbox command can delete). One exec, either way.
        await fsWithWakeRetry(
          sprite,
          'write',
          () => fs.writeFile(file.path, data, file.mode === undefined ? undefined : { mode: file.mode }),
          [parentDir(file.path)],
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

    async createCheckpoint(comment: string): Promise<void> {
      // The SDK call itself may reject (transport failure, sprite unreachable)
      // BEFORE ever returning a stream — that propagates as-is. Once we have a
      // stream, drain it fully (checkpoints are ~300ms COW, so this is fast)
      // and surface the first `error`-type message as a rejection. Fail-open
      // policy (never block the caller's batch on this) is the SHELL's
      // decision (tool-runners.ts), not this driver's — this method faithfully
      // reports success or failure.
      //
      // Bounded by CHECKPOINT_TIMEOUT_MS: the SDK exposes no timeout or abort
      // handle for either `createCheckpoint` or the stream it returns, so a
      // stalled connection would otherwise hang this call forever — the
      // shell's own timeout (tool-runners.ts) already stops the CALLER from
      // blocking on that, but without a bound HERE too the abandoned stream
      // read lingers in the background indefinitely, holding whatever
      // connection/socket resource it holds. On timeout we best-effort close
      // the stream (if we got one) to release that resource instead of
      // leaving it to read forever nobody is listening to.
      let stream: SpriteCheckpointStreamLike | undefined;
      const drain = async (): Promise<void> => {
        stream = await sprite.createCheckpoint(comment);
        let streamError: string | undefined;
        await stream.processAll((message) => {
          if (streamError === undefined) {
            streamError = checkpointStreamErrorMessage(message);
          }
        });
        if (streamError !== undefined) {
          throw new Error(`Sandbox checkpoint failed: ${streamError}`);
        }
      };

      let settled = false;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            stream?.close();
          } catch {
            // Best-effort cleanup only; the timeout error below is what
            // actually propagates.
          }
          reject(new Error(`Sandbox checkpoint timed out after ${CHECKPOINT_TIMEOUT_MS}ms`));
        }, CHECKPOINT_TIMEOUT_MS);
        drain().then(
          () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          },
          (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          },
        );
      });
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

/** The outcome of a failed lockdown attempt: keep the VM around, or give up on it. */
export type ProvisionFailurePlan = 'retain-and-refuse' | 'destroy';

/**
 * Pure: after a Sprite fails its `attempt`-th lockdown (of at most
 * `maxAttempts`), is it still worth RETAINING (retry the SAME VM again), or has
 * it proven genuinely unusable and earned a DESTROY?
 *
 * A RESUMED Sprite (`fresh: false`) is NEVER destroyed here, no matter how many
 * attempts: this caller does not own its lifecycle, and a warm session with a
 * flaky lockdown is still cheaper to keep retrying than to throw away (sprites
 * are meant to be created once and reused — docs.sprites.dev/working-with-sprites).
 * It already has a persisted session row a user (or a future operator tool) can
 * act on, so there is no "poisoned with no way out" risk in leaving it to retry
 * indefinitely — this IS a deliberate asymmetry with the fresh case below, not
 * an oversight: a resumed Sprite that stays permanently broken degrades to "this
 * one Machine/branch needs a human to delete and re-provision it," which is a
 * known, acceptable outcome, never a silent resource leak (see
 * `applyEgressLockdown`'s doc for the loop that enforces this).
 *
 * A FRESH Sprite is different: on its VERY FIRST successful `getOrCreate`
 * (fresh create, no session row yet — see `provisionFreshMachine`), a
 * persistently broken VM (filesystem corruption, a policy API that rejects
 * THIS instance specifically) would otherwise poison the session key forever —
 * no row is ever saved for the caller to find and tear down. So `attempt` here
 * is a BOUNDED retry budget `applyEgressLockdown` exhausts WITHIN one
 * `getOrCreate` call (see its bounded-retry loop): fewer than `maxAttempts`
 * failures retains and retries once more with backoff; reaching `maxAttempts`
 * means the VM has had every reasonable chance and is destroyed so the next
 * acquire provisions a clean one instead of retrying forever against a broken VM.
 */
export function planProvisionFailure({
  fresh,
  attempt,
  maxAttempts,
}: {
  fresh: boolean;
  attempt: number;
  maxAttempts: number;
}): ProvisionFailurePlan {
  if (!fresh) return 'retain-and-refuse';
  return attempt >= maxAttempts ? 'destroy' : 'retain-and-refuse';
}

// A FRESH Sprite gets this many lockdown attempts (with backoff) inside ONE
// `getOrCreate` call before it is judged genuinely unusable and destroyed — see
// `planProvisionFailure`. A RESUMED Sprite gets exactly one attempt (it already
// has a session row a user can act on, so there is no urgency to retry inline —
// see `applyEgressLockdown`'s call site).
const PROVISION_LOCKDOWN_MAX_ATTEMPTS = 3;

/**
 * Apply the deny-by-default egress policy and ensure the sandbox root exists,
 * retrying a FAILED lockdown up to `maxAttempts` times (with backoff) before
 * giving up. Called only when the policy is NOT already known-good on this
 * Sprite (fresh create, hash mismatch, or unknown recorded state — see
 * `shouldApplyPolicy`), so a Sprite is never returned with open/unknown egress
 * and a warm resume pays no redundant control-plane round-trip.
 *
 * The retry loop is what keeps a FRESH Sprite from being poisoned forever by a
 * transient flake without ALSO being destroyed the instant a genuinely broken
 * one fails: `planProvisionFailure` decides, on each failure, whether this was
 * merely attempt N of a bounded budget (retry again) or the last chance
 * (destroy — see its doc). Only the step that actually failed is retried: once
 * `updateNetworkPolicy` lands, it is not re-pushed on a later attempt whose
 * `mkdir` alone failed — needless repeat control-plane calls would otherwise
 * risk tripping the policy API's own rate limiting on an already-healthy step.
 *
 * A RESUMED Sprite's caller passes `maxAttempts: 1`, so its first failure hits
 * the loop's ceiling immediately: `planProvisionFailure` never returns
 * 'destroy' for `fresh: false` (see its doc), so the explicit
 * `attempt >= maxAttempts` check below — not `planProvisionFailure` — is what
 * actually bounds THAT case. Do not delete it as "redundant": for a fresh
 * Sprite it is provably unreachable (planProvisionFailure already returns
 * 'destroy' at that same boundary), but for a resumed one it is the only thing
 * standing between a single failed attempt and an infinite retry loop.
 *
 * This deliberately does NOT reuse the file's `withWakeRetry` executor above:
 * that one retries ONLY a structurally-detected pre-open wake-drop and never
 * destroys anything, while this one retries any lockdown failure and destroys
 * on exhaustion — different enough plans that sharing one generic executor
 * would need threading a plan callback through `withWakeRetry` for a single
 * caller, more indirection than the duplication it would save.
 *
 * Nested retry note: the `mkdir` step below goes through
 * `runSpawnedWithWakeRetry`, which has its OWN bounded wake-drop retry
 * (`MAX_EXEC_ATTEMPTS`, each capped at the 30s passed here). In the
 * vanishingly rare worst case where a Sprite hits pre-open wake-drops on every
 * inner attempt AND every outer attempt, the two bounds compound
 * (`maxAttempts` × `MAX_EXEC_ATTEMPTS` × 30s, plus backoff) — several minutes,
 * not the ~90s a glance at `maxAttempts` alone suggests. This is accepted: it
 * requires a VM that is broken in a very specific, narrow way, this driver
 * runs inside long-lived Fly services (not a hard-timeout serverless
 * function), and the alternative — a shorter per-attempt timeout — risks
 * misjudging a merely slow-to-wake but healthy cold boot as "unusable" (the
 * exact failure mode this leaf exists to fix).
 *
 * Residual risk (accepted, out of scope): if the PROCESS itself is killed
 * mid-loop (a Fly Machine restart/OOM, not a request timeout — see above),
 * a fresh Sprite that hasn't yet exhausted its budget survives undestroyed. The
 * NEXT `getOrCreate` for that name then finds it via `sdk.getSprite` (success,
 * not not-found), so `fresh` becomes `false` and it is treated as a RESUMED
 * Sprite from then on — retained and refused forever if still broken, same as
 * any other persistently-broken resumed Sprite (see `planProvisionFailure`'s
 * doc on that asymmetry). Closing this fully would need a durable,
 * cross-acquire attempt counter (e.g. persisted on the session row) — that is
 * the same class of work as the reaper this leaf explicitly declines to build.
 *
 * Either way the error still propagates so the caller refuses to hand back a
 * Sprite without a confirmed policy.
 */
async function applyEgressLockdown({
  sdk,
  sprite,
  policy,
  fresh,
  maxAttempts,
  baseDelayMs = RETRY_BASE_DELAY_MS,
  sleep = delay,
}: {
  sdk: SpritesSdk;
  sprite: SpriteInstanceLike;
  policy: NetworkPolicy;
  fresh: boolean;
  maxAttempts: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  let policyApplied = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (!policyApplied) {
        await sprite.updateNetworkPolicy(policy);
        policyApplied = true;
      }
      // Use spawn + runSpawned (30 s wall-clock) to create the workspace dir
      // instead of filesystem().mkdir(). The filesystem API uses a bare fetch()
      // with no AbortSignal — it hangs for 52–90 s when the Sprite VM is
      // cold-booting and Fly's proxy eventually closes the connection. spawn()
      // connects via WebSocket, which is the designated wake-up path;
      // runSpawned enforces the timeout and SIGKILLs if the Sprite never
      // becomes ready.
      await runSpawnedWithWakeRetry(() => sprite.spawn('mkdir', ['-p', SANDBOX_ROOT]), DEFAULT_MAX_OUTPUT_BYTES, 30_000);
      return;
    } catch (error) {
      const plan = planProvisionFailure({ fresh, attempt, maxAttempts });
      if (plan === 'destroy') {
        try {
          await sdk.deleteSprite(sprite.name);
        } catch {
          // Best-effort cleanup of a Sprite we refuse to hand back.
        }
        throw error;
      }
      // Reached for a RESUMED Sprite once its (single-attempt) budget is spent
      // — see this function's doc on why this check, not planProvisionFailure,
      // is what bounds that case.
      if (attempt >= maxAttempts) throw error;
      await sleep(wakeRetryDelayMs(attempt, baseDelayMs));
    }
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

export function createSpritesSandboxClient({
  sdk,
  // Injectable so a test can exercise the bounded lockdown-retry backoff
  // without real wall-clock waits. Production uses the real timer.
  sleep = delay,
}: {
  sdk: SpritesSdk;
  sleep?: (ms: number) => Promise<void>;
}): ExecSandboxClient {
  return {
    async getOrCreate({ name, options, appliedEgressToken }) {
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
        // Lock down egress only when THIS VM is not already proven to be running
        // THIS policy — see the file header and `../egress-lockdown.ts`. The proof
        // is a token over (Sprite instance id, policy hash): a warm resume of the
        // same VM under the same policy skips the control-plane round-trip and the
        // `mkdir` exec entirely (both the policy file and the sandbox root are
        // persistent), while a Sprite that was re-created under this name — even
        // by a concurrent caller that has not reached its own lockdown yet — has a
        // different id, does not match, and is locked down here rather than handed
        // back on the platform's default open egress.
        const policy = buildSpriteNetworkPolicy({
          egressAllowlist: options.egressAllowlist,
          egressMode: options.egressMode,
        });
        const desiredToken = egressLockdownToken({ spriteId: sprite.id, policyHash: hashPolicy(policy) });
        if (shouldApplyPolicy({ fresh, appliedToken: appliedEgressToken, desiredToken })) {
          // A FRESH Sprite gets a bounded retry budget (see planProvisionFailure)
          // before it is judged unusable; a RESUMED one gets exactly one attempt
          // — it already has a session row a user can act on if this keeps failing.
          await applyEgressLockdown({
            sdk,
            sprite,
            policy,
            fresh,
            maxAttempts: fresh ? PROVISION_LOCKDOWN_MAX_ATTEMPTS : 1,
            sleep,
          });
        }
        // wrap sets sandboxId = sprite.name = spriteName (truncated). The token is
        // now CONFIRMED for this VM (freshly applied, or already proven) — the
        // caller records it, and it is what lets the next hand-back skip the push.
        return wrap(sprite, desiredToken);
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
      // Irreversible DESTROY, never a checkpoint — see the file header. Callers
      // must only invoke this for genuine teardown intent, never idle cleanup.
      await sdk.deleteSprite(sandboxId);
    },
  };
}
