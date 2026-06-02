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
 *  - **Caps** — RAM / vCPUs / region come from the resolved policy.
 *  - **No secrets** — the allowlisted env is set by the caller via
 *    `buildSandboxEnv`; this driver injects none. v1 brokers no outbound
 *    credentials (a Fly Tokenizer proxy is the future path, out of scope).
 *
 * `stop` DESTROYS the Sprite (not a checkpoint) so there is no orphaned/idle
 * billing. The per-command timeout is enforced here because the SDK's
 * exec API exposes none.
 *
 * The SDK is injected (`sdk`) so the mapping — create/resume, policy lockdown,
 * exit/stdout/stderr surfacing, get→null on a vanished Sprite — is unit-tested
 * with a fake, never against the real Sprites API.
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

/** Sprite config the driver sets explicitly from the resolved policy. */
export interface SpriteConfigParams {
  ramMB: number;
  cpus: number;
  region: string;
}

/** The Sprite filesystem subset the driver consumes. */
export interface SpriteFsLike {
  readFile(path: string, encoding: null): Promise<Buffer>;
  writeFile(path: string, data: string | Buffer, options?: { mode?: number }): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/** The Sprite instance subset the driver consumes. */
export interface SpriteInstanceLike {
  readonly name: string;
  execFile(
    file: string,
    args?: string[],
    options?: { cwd?: string; env?: Record<string, string>; encoding?: BufferEncoding },
  ): Promise<{ exitCode: number; stdout: string | Buffer; stderr: string | Buffer }>;
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
  };
}

function toText(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8');
}

// Shape of the exec output a non-zero exit carries (on `ExecError`).
interface ExecOutputShape {
  exitCode: number;
  stdout: string | Buffer;
  stderr: string | Buffer;
}

function isExecOutputShape(value: unknown): value is ExecOutputShape {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { exitCode?: unknown }).exitCode === 'number'
  );
}

// Surface from a thrown SDK `ExecError` (non-zero exit) — duck-typed so tests
// need not import the SDK class. The Sprites `ExecError` exposes the exit
// output BOTH nested under `.result` and flattened on the error itself (via
// `exitCode`/`stdout`/`stderr` getters); we accept either so a version skew in
// the SDK's surface can't turn a real non-zero exit into a transport failure. A
// genuine command that exits non-zero is a RESULT, not a driver failure, so it
// is returned, never rethrown.
function execResultFromError(error: unknown): SandboxRunResult | null {
  const nested = (error as { result?: unknown } | null)?.result;
  const output = isExecOutputShape(nested) ? nested : isExecOutputShape(error) ? error : null;
  if (!output) return null;
  return { exitCode: output.exitCode, stdout: toText(output.stdout), stderr: toText(output.stderr) };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SandboxCommandTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function wrap(sprite: SpriteInstanceLike): ExecutableSandbox {
  return {
    sandboxId: sprite.name,

    async runCommand({ cmd, args = [], cwd, env, timeoutMs }: RunCommandArgs): Promise<SandboxRunResult> {
      try {
        // execFile (arg array), never a host-side shell string. The untrusted
        // command runs under the Sprite's own `sh -c`, contained by the VM.
        const result = await withTimeout(
          sprite.execFile(cmd, args, { cwd, env, encoding: 'utf8' }),
          timeoutMs,
        );
        return { exitCode: result.exitCode, stdout: toText(result.stdout), stderr: toText(result.stderr) };
      } catch (error) {
        // A non-zero exit arrives as a thrown ExecError carrying the output —
        // return it as a result, not a failure.
        const asResult = execResultFromError(error);
        if (asResult) return asResult;
        // The SDK exec API exposes no per-command kill, so on a timeout we DESTROY
        // the Sprite (rule §40: guaranteed teardown on timeout): an abandoned
        // runaway process must not keep burning compute against the app-level cost
        // ceiling. The conversation re-provisions a fresh Sprite on its next turn.
        if (error instanceof SandboxCommandTimeoutError) {
          void sprite.destroy().catch(() => {});
        }
        // A timeout or transport error propagates so the runner records the
        // anomaly and fails the run.
        throw error;
      }
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
