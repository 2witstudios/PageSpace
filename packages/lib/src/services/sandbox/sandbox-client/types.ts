/**
 * Provider-neutral execution-client contract.
 *
 * PR2 defined the minimal `SandboxClient` lifecycle seam (getOrCreate / get /
 * stop) in `machine-session-manager`. The tools need to actually run commands and touch
 * files, so this module extends that seam with an execution surface —
 * `ExecutableSandbox` — kept deliberately provider-agnostic. The concrete driver
 * (Fly Sprites today) implements `ExecSandboxClient`; the runners depend only on
 * these interfaces, so swapping the backing provider never touches the safety
 * layer.
 */

import type { SandboxClient, SandboxHandle, SandboxGetOrCreateArgs } from '../machine-session-manager';

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
  /**
   * Hard wall-clock cap, in ms, enforced by the driver. On expiry the driver
   * SIGKILLs the running command so no process keeps running past the cap.
   */
  timeoutMs?: number;
  /**
   * Hard cap, in bytes, on buffered stdout+stderr (the policy output cap). The
   * driver maps this onto the SDK's `maxBuffer`: exceeding it SIGKILLs the
   * command and fails the run, bounding host memory against an output flood.
   */
  maxBytes?: number;
}

export interface WriteFileEntry {
  path: string;
  content: string | Uint8Array;
  mode?: number;
}

/**
 * The minimal lifecycle handle (PR2) plus the execution surface the tools drive.
 * The runners reconnect to this via `client.get` after the lifecycle gate has
 * authorized the conversation.
 */
export interface ExecutableSandbox extends SandboxHandle {
  runCommand(args: RunCommandArgs): Promise<SandboxRunResult>;
  writeFiles(files: WriteFileEntry[]): Promise<void>;
  readFileToBuffer(args: { path: string }): Promise<Buffer | null>;
  /**
   * Create a filesystem checkpoint tagged with `comment` (Sprites Platform
   * Alignment 5-2: a safety net before destructive agent bash batches — see
   * `checkpoint-policy.ts`). Resolves once the checkpoint is confirmed, or
   * rejects on failure; the caller decides fail-open policy.
   */
  createCheckpoint(comment: string): Promise<void>;
}

/** Extends the PR2 lifecycle seam so one client serves both layers. */
export interface ExecSandboxClient extends SandboxClient {
  getOrCreate(args: SandboxGetOrCreateArgs): Promise<ExecutableSandbox>;
  get(args: { sandboxId: string }): Promise<ExecutableSandbox | null>;
}
