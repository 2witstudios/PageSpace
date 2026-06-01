/**
 * Real `@vercel/sandbox` client adapter (IO).
 *
 * PR2 defined the `SandboxClient` seam (getOrCreate / get / stop) but owned no
 * execution path. This module implements that seam against the actual SDK and
 * extends it with the execution surface the PR3 tools need — `runCommand`,
 * `writeFiles`, `readFileToBuffer` — exposed on an `ExecutableSandbox` handle.
 *
 * Provisioning is locked down here, not left to the SDK defaults:
 *  - **Egress** is the resolved policy's allowlist, translated to a network
 *    policy that is `deny-all` by default and can never reach internal targets
 *    (see `buildSandboxNetworkPolicy`).
 *  - **Env** is built by allowlist via `buildSandboxEnv` — no host secrets ever
 *    enter the VM. Outbound credentials (when a future profile needs them) are
 *    brokered through the network policy's request transforms, never injected as
 *    raw secrets in the sandbox environment.
 *  - **Caps** (timeout, vCPUs, persistence) come from the policy, never platform
 *    defaults.
 *
 * The SDK statics are injected (`sdk`) so the adapter's mapping — create params,
 * exit/stdout/stderr surfacing, get→null on a vanished sandbox — is unit-tested
 * with a fake, never against the real Vercel API.
 */

import { Sandbox, type NetworkPolicy } from '@vercel/sandbox';
import { getValidatedEnv } from '../../config/env-validation';
import { buildSandboxEnv } from './sandbox-env';
import { buildSandboxNetworkPolicy } from './egress';
import type { SandboxClient, SandboxHandle } from './session-manager';
import type { SandboxCreateOptions } from './sandbox-options';

/** Result of a single command run inside the sandbox. */
export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandArgs {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Hard wall-clock cap, in ms; the sandbox SIGKILLs the process on expiry. */
  timeoutMs?: number;
}

export interface WriteFileEntry {
  path: string;
  content: string | Uint8Array;
  mode?: number;
}

/**
 * The minimal lifecycle handle (PR2) plus the execution surface PR3 drives. The
 * tool runners reconnect to this via `client.get` to run commands and touch
 * files after the lifecycle gate has authorized the conversation.
 */
export interface ExecutableSandbox extends SandboxHandle {
  runCommand(args: RunCommandArgs): Promise<SandboxRunResult>;
  writeFiles(files: WriteFileEntry[]): Promise<void>;
  readFileToBuffer(args: { path: string }): Promise<Buffer | null>;
}

/** Extends the PR2 lifecycle seam so the same client serves both layers. */
export interface ExecSandboxClient extends SandboxClient {
  getOrCreate(args: { name: string; options: SandboxCreateOptions }): Promise<ExecutableSandbox>;
  get(args: { sandboxId: string }): Promise<ExecutableSandbox | null>;
}

/** The subset of a real `Sandbox` instance the adapter consumes. */
export interface SandboxInstance {
  readonly name: string;
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ exitCode: number; stdout(): Promise<string>; stderr(): Promise<string> }>;
  writeFiles(files: WriteFileEntry[]): Promise<void>;
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  stop(): Promise<unknown>;
}

/** The injectable SDK statics. Defaults to the real `@vercel/sandbox`. */
export interface SandboxSdk {
  getOrCreate(params: Record<string, unknown>): Promise<SandboxInstance>;
  get(params: Record<string, unknown>): Promise<SandboxInstance>;
}

export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

/**
 * Resolve explicit Vercel credentials from validated env. Returns `null` when
 * any of the three are absent — the SDK then falls back to the OIDC token that
 * is present automatically on Vercel, so a complete local triad or a deployed
 * OIDC context both work, and a partial config never half-authenticates.
 */
export function resolveVercelCredentials({
  env = safeEnv(),
}: { env?: Partial<Record<string, string>> } = {}): VercelCredentials | null {
  const token = env.VERCEL_TOKEN;
  const teamId = env.VERCEL_TEAM_ID;
  const projectId = env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }
  return null;
}

function safeEnv(): Partial<Record<string, string>> {
  try {
    return getValidatedEnv() as unknown as Partial<Record<string, string>>;
  } catch {
    return {};
  }
}

// Allowlisted sandbox env, fail-safe: if env validation hiccups we provision an
// EMPTY env (the safest possible — never host secrets) rather than throwing out
// of provisioning.
function safeBuildSandboxEnv(): Record<string, string> {
  try {
    return buildSandboxEnv();
  } catch {
    return {};
  }
}

/**
 * The VM's max lifetime before the platform auto-terminates it. This is the
 * SANDBOX's wall-clock budget, NOT a single command's cap: a conversation reuses
 * one warm sandbox across turns, so the VM must outlive the per-run `timeoutMs`
 * (and the lifecycle's idle-reclaim window) or every turn would re-provision from
 * scratch. Per-command timeouts are enforced separately on `runCommand`. Kept
 * comfortably above the 15-minute idle reclaim and within the platform cap.
 */
export const SANDBOX_VM_LIFETIME_MS = 30 * 60 * 1000;

/**
 * Build the `Sandbox.getOrCreate`/`create` params from the resolved policy
 * options. Pure and total: region and memory are intentionally omitted (the SDK
 * derives memory from vCPUs and does not accept a region here), while the VM
 * lifetime, vCPUs, persistence, the deny-by-default network policy, and the
 * allowlisted env are all set explicitly so no platform default leaks in.
 *
 * The VM `timeout` is the session lifetime, never below the policy's per-run cap
 * (a misconfigured tiny lifetime would otherwise kill warm reuse) — the per-run
 * cap itself is applied to each `runCommand`, not to the sandbox.
 */
export function buildSandboxCreateParams({
  name,
  options,
  env = safeBuildSandboxEnv(),
  networkPolicy,
  credentials = resolveVercelCredentials(),
  runtime = 'node24',
}: {
  name: string;
  options: SandboxCreateOptions;
  env?: Record<string, string>;
  networkPolicy?: NetworkPolicy;
  credentials?: VercelCredentials | null;
  runtime?: string;
}): Record<string, unknown> {
  return {
    name,
    timeout: Math.max(SANDBOX_VM_LIFETIME_MS, options.timeoutMs),
    resources: { vcpus: options.vcpus },
    runtime,
    persistent: options.persistent,
    networkPolicy:
      networkPolicy ?? buildSandboxNetworkPolicy({ egressAllowlist: options.egressAllowlist }),
    env,
    ...(credentials ? credentials : {}),
  };
}

function wrap(instance: SandboxInstance): ExecutableSandbox {
  return {
    sandboxId: instance.name,
    async runCommand({ cmd, args, cwd, env, timeoutMs }) {
      const finished = await instance.runCommand({ cmd, args, cwd, env, timeoutMs });
      const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
      return { exitCode: finished.exitCode, stdout, stderr };
    },
    writeFiles(files) {
      return instance.writeFiles(files);
    },
    readFileToBuffer({ path }) {
      return instance.readFileToBuffer({ path });
    },
  };
}

const defaultSdk: SandboxSdk = {
  getOrCreate: (params) => Sandbox.getOrCreate(params as never) as Promise<SandboxInstance>,
  get: (params) => Sandbox.get(params as never) as Promise<SandboxInstance>,
};

export function createVercelSandboxClient({
  sdk = defaultSdk,
}: { sdk?: SandboxSdk } = {}): ExecSandboxClient {
  return {
    async getOrCreate({ name, options }) {
      const params = buildSandboxCreateParams({ name, options });
      return wrap(await sdk.getOrCreate(params));
    },

    async get({ sandboxId }) {
      // `get` resumes by the conversation-scoped name. A vanished sandbox
      // (platform-expired / crashed) surfaces as an error from the SDK; map it
      // to null so the lifecycle re-provisions under the same key rather than
      // throwing. Resume defaults to true on the SDK.
      try {
        return wrap(await sdk.get({ name: sandboxId }));
      } catch {
        return null;
      }
    },

    async stop({ sandboxId }) {
      const instance = await sdk.get({ name: sandboxId });
      await instance.stop();
    },
  };
}
