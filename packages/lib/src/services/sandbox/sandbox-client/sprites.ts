/**
 * Fly Sprites driver (IO) for the provider-neutral `ExecSandboxClient` seam.
 *
 * Implements PR2's `SandboxClient` lifecycle (getOrCreate / get / stop) and the
 * PR3 execution surface (runCommand / writeFiles / readFileToBuffer) against
 * `@fly/sprites`. A Sprite is named by the conversation session key, so
 * `getOrCreate` resumes an existing Sprite by name or creates a fresh one.
 *
 * Provisioning is locked down, never platform defaults:
 *  - **Egress** — on EVERY acquire (a fresh create AND a resume of a pre-existing
 *    Sprite) the deny-by-default L3 network policy is (re)applied before the
 *    Sprite is handed back. If that application fails the Sprite is destroyed and
 *    the acquire rejects: a Sprite is NEVER handed back without its egress
 *    lockdown confirmed, so a crash between create and lockdown — or a resume
 *    under a tightened egress profile — can never leak open/stale egress.
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

import { SpritesClient, type NetworkPolicy } from '@fly/sprites';
import { getValidatedEnv } from '../../../config/env-validation';
import { buildSpriteNetworkPolicy } from '../egress';
import { SANDBOX_ROOT } from '../sandbox-paths';
import {
  SandboxReadLimitError,
  type ExecSandboxClient,
  type ExecutableSandbox,
  type SandboxRunResult,
  type RunCommandArgs,
  type WriteFileEntry,
} from './types';
import type { SandboxCreateOptions } from '../sandbox-options';

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

/**
 * Sprite config the driver sets explicitly from the resolved policy. A subset of
 * the SDK's `SpriteConfig` (`ramMB` / `cpus` / `region` / `storageGB`).
 */
export interface SpriteConfigParams {
  ramMB: number;
  cpus: number;
  region: string;
  storageGB: number;
}

/** The Sprite filesystem subset the driver consumes. */
export interface SpriteFsLike {
  readFile(path: string, encoding: null): Promise<Buffer>;
  writeFile(path: string, data: string | Buffer, options?: { mode?: number }): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
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
 */
export interface SpriteCommandLike {
  readonly stdout: SpriteStreamLike;
  readonly stderr: SpriteStreamLike;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  kill(signal?: string): void;
}

/** The Sprite instance subset the driver consumes. */
export interface SpriteInstanceLike {
  readonly name: string;
  spawn(
    file: string,
    args?: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): SpriteCommandLike;
  filesystem(workingDir?: string): SpriteFsLike;
  updateNetworkPolicy(policy: NetworkPolicy): Promise<void>;
  destroy(): Promise<void>;
}

/** The injectable Sprites SDK statics. Defaults to the real `@fly/sprites`. */
export interface SpritesSdk {
  getSprite(name: string): Promise<SpriteInstanceLike>;
  createSprite(name: string, config?: SpriteConfigParams): Promise<SpriteInstanceLike>;
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

/** Map the resolved policy options to the Sprite create config (explicit caps). */
export function buildSpriteConfig({ options }: { options: SandboxCreateOptions }): SpriteConfigParams {
  return {
    ramMB: options.memoryMb,
    cpus: options.vcpus,
    region: options.region,
    storageGB: options.storageGb,
  };
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

function wrap(sprite: SpriteInstanceLike): ExecutableSandbox {
  return {
    sandboxId: sprite.name,

    async runCommand({ cmd, args = [], cwd, env, timeoutMs, maxBytes }: RunCommandArgs): Promise<SandboxRunResult> {
      // spawn (arg array), never a host-side shell string. The untrusted command
      // runs under the Sprite's own `sh -c`, contained by the VM.
      const command = sprite.spawn(cmd, args, { cwd, env });
      return runSpawned(command, maxBytes ?? 0, timeoutMs);
    },

    async writeFiles(files: WriteFileEntry[]): Promise<void> {
      const fs = sprite.filesystem('/');
      for (const file of files) {
        const data = typeof file.content === 'string' ? file.content : Buffer.from(file.content);
        await fs.writeFile(file.path, data, file.mode === undefined ? undefined : { mode: file.mode });
      }
    },

    async readFileToBuffer({ path, maxBytes }: { path: string; maxBytes?: number }): Promise<Buffer | null> {
      const fs = sprite.filesystem('/');
      try {
        if (maxBytes !== undefined && maxBytes > 0) {
          // Stat FIRST so an oversized file is refused before its bytes are pulled
          // into the host process — the cap is a host-memory DoS guard, not just a
          // display limit, so it must bound the read at the API boundary. A stat
          // failure (missing file) falls through to the null not-found path below.
          const stats = await fs.stat(path);
          if (typeof stats.size === 'number' && stats.size > maxBytes) {
            throw new SandboxReadLimitError(maxBytes);
          }
        }
        return await fs.readFile(path, null);
      } catch (error) {
        // A refused oversized read propagates; anything else (missing file / read
        // failure) resolves to null, which the runner maps to a handled not-found.
        if (error instanceof SandboxReadLimitError) throw error;
        return null;
      }
    },
  };
}

const defaultSdk = (): SpritesSdk => {
  const client = new SpritesClient(resolveSpritesToken());
  return {
    getSprite: (name) => client.getSprite(name) as unknown as Promise<SpriteInstanceLike>,
    createSprite: (name, config) =>
      client.createSprite(name, config) as unknown as Promise<SpriteInstanceLike>,
    deleteSprite: (name) => client.deleteSprite(name),
  };
};

/**
 * Classify a Sprites SDK error as a "the named Sprite does not exist" signal,
 * the ONLY error we may swallow when resolving a Sprite by name. The SDK surfaces
 * a not-found either as a structured `APIError` carrying `statusCode: 404` or, when
 * the error body cannot be parsed, as a generic `Error("Failed to get sprite
 * (status 404): …")`. Everything else — auth (401/403), rate limits (429),
 * control-plane/transport failures — must propagate so the caller never mistakes a
 * transient outage for a missing Sprite (and never silently re-creates over one).
 */
export function isSpriteNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { statusCode?: unknown; status?: unknown; code?: unknown; message?: unknown };
  if (e.statusCode === 404 || e.status === 404) return true;
  if (e.code === 'ENOENT' || e.code === 'not_found' || e.code === 'NOT_FOUND') return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /\b404\b/.test(message) || /not[\s_-]?found/i.test(message);
}

// Apply the deny-by-default egress policy and ensure the sandbox root exists.
// Run on EVERY acquire — both a fresh create and a resume of a pre-existing
// Sprite — because the deny-all network policy is the egress boundary and must
// be (re)affirmed before any command runs: a process that died after
// `createSprite()` but before this lockdown, or a Sprite resumed under a since-
// tightened egress profile, would otherwise hand back open/stale egress. If the
// lockdown cannot be applied the Sprite is destroyed and the error propagates —
// a Sprite is NEVER returned without its egress lockdown confirmed (fail-closed).
async function lockdownSprite(
  sdk: SpritesSdk,
  sprite: SpriteInstanceLike,
  options: SandboxCreateOptions,
): Promise<void> {
  try {
    await sprite.updateNetworkPolicy(buildSpriteNetworkPolicy({ egressAllowlist: options.egressAllowlist }));
    await sprite.filesystem('/').mkdir(SANDBOX_ROOT, { recursive: true });
  } catch (error) {
    try {
      await sdk.deleteSprite(sprite.name);
    } catch {
      // Best-effort cleanup of a Sprite we refuse to hand back.
    }
    throw error;
  }
}

export function createSpritesSandboxClient({
  sdk = defaultSdk(),
}: { sdk?: SpritesSdk } = {}): ExecSandboxClient {
  return {
    async getOrCreate({ name, options }) {
      // Resume by name when the Sprite already exists; otherwise create fresh.
      // A not-found is the only swallowed error — any other failure (auth, rate
      // limit, control-plane outage) propagates rather than masquerading as a
      // missing Sprite that we would wrongly re-create over.
      let sprite: SpriteInstanceLike;
      try {
        sprite = await sdk.getSprite(name);
      } catch (error) {
        if (!isSpriteNotFoundError(error)) throw error;
        sprite = await sdk.createSprite(name, buildSpriteConfig({ options }));
      }
      // (Re)apply the egress lockdown before handing back ANY Sprite — fresh or
      // resumed — so a crash window between create and lockdown, or a resume
      // under a tightened egress profile, can never leak open/stale egress. Mutable
      // network policy is re-enforced here; immutable caps (RAM/storage) are fixed
      // for the warm Sprite's life and a profile change takes effect on the next
      // cold provision (idle teardown / session end).
      await lockdownSprite(sdk, sprite, options);
      return wrap(sprite);
    },

    async get({ sandboxId }) {
      // Reconnect by name; a vanished (not-found) Sprite surfaces as null so the
      // lifecycle re-provisions under the same key. Any other error propagates so
      // a transient outage is not mistaken for a gone Sprite.
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
