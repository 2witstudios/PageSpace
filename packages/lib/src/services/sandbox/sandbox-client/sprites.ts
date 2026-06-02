/**
 * Fly Sprites driver (IO) for the provider-neutral `ExecSandboxClient` seam.
 *
 * Implements PR2's `SandboxClient` lifecycle (getOrCreate / get / stop) and the
 * PR3 execution surface (runCommand / writeFiles / readFileToBuffer) against
 * `@fly/sprites`. A Sprite is named by the conversation session key, so
 * `getOrCreate` resumes an existing Sprite by name or creates a fresh one.
 *
 * Provisioning is locked down, never platform defaults:
 *  - **Egress** — immediately after a fresh create, the deny-by-default L3
 *    network policy is applied. If that application fails the just-created
 *    Sprite is destroyed and the create rejects: a Sprite is NEVER handed back
 *    without its egress lockdown in place.
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
import type {
  ExecSandboxClient,
  ExecutableSandbox,
  SandboxRunResult,
  RunCommandArgs,
  WriteFileEntry,
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
      chunks.push(buf);
      const next = len + buf.length;
      if (next > maxBuffer) {
        // Output flood: SIGKILL the firehose and fail, mirroring the SDK's own
        // maxBuffer-exceeded behaviour (a DoS guard on host memory).
        try {
          command.kill('SIGKILL');
        } catch {
          // Best-effort kill; the wall-clock timer / idle reaper still bound it.
        }
        fail(new SandboxOutputLimitError(maxBuffer));
      }
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

    async readFileToBuffer({ path }: { path: string }): Promise<Buffer | null> {
      try {
        return await sprite.filesystem('/').readFile(path, null);
      } catch {
        // A missing file (or any read failure) resolves to null; the runner maps
        // null to a handled not-found rather than an exception.
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

// Apply the deny-by-default egress policy and ensure the sandbox root exists.
// If the egress lockdown cannot be applied the Sprite is destroyed and the
// error propagates — a Sprite is never returned with open/unknown egress.
async function lockdownFreshSprite(
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
      // Resume by name when the Sprite already exists; otherwise create fresh and
      // lock it down before returning.
      try {
        return wrap(await sdk.getSprite(name));
      } catch {
        const sprite = await sdk.createSprite(name, buildSpriteConfig({ options }));
        await lockdownFreshSprite(sdk, sprite, options);
        return wrap(sprite);
      }
    },

    async get({ sandboxId }) {
      // Reconnect by name; a vanished Sprite surfaces as an error → null so the
      // lifecycle re-provisions under the same key rather than throwing.
      try {
        return wrap(await sdk.getSprite(sandboxId));
      } catch {
        return null;
      }
    },

    async stop({ sandboxId }) {
      // DESTROY, not checkpoint — no orphaned/idle billing.
      await sdk.deleteSprite(sandboxId);
    },
  };
}
