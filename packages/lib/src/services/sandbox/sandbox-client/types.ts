/**
 * Provider-neutral execution-client contract.
 *
 * PR2 defined the minimal `SandboxClient` lifecycle seam (getOrCreate / get /
 * stop) in `session-manager`. The tools need to actually run commands and touch
 * files, so this module extends that seam with an execution surface —
 * `ExecutableSandbox` — kept deliberately provider-agnostic. The concrete driver
 * (Fly Sprites today) implements `ExecSandboxClient`; the runners depend only on
 * these interfaces, so swapping the backing provider never touches the safety
 * layer.
 */

import type { SandboxClient, SandboxHandle } from '../session-manager';
import type { SandboxCreateOptions } from '../sandbox-options';

/**
 * Provider-neutral signal that a file read was refused because the file exceeds
 * the caller's byte cap. Thrown by the driver from `readFileToBuffer` BEFORE the
 * oversized body is pulled into the host process, so the cap bounds host memory
 * rather than only trimming an already-materialized buffer. The runner maps it to
 * a `content_too_large` denial. Kept here (not in a provider module) so the
 * runners can catch it without importing the Fly Sprites driver.
 */
export class SandboxReadLimitError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Sandbox file exceeds the ${maxBytes}-byte read cap`);
    this.name = 'SandboxReadLimitError';
  }
}

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
  /**
   * Read a file's bytes, or null when it is missing/unreadable. When `maxBytes`
   * is supplied the driver MUST refuse (throw `SandboxReadLimitError`) a file that
   * exceeds it BEFORE buffering the whole body, so the cap bounds host memory
   * rather than only trimming an already-materialized buffer.
   */
  readFileToBuffer(args: { path: string; maxBytes?: number }): Promise<Buffer | null>;
}

/** Extends the PR2 lifecycle seam so one client serves both layers. */
export interface ExecSandboxClient extends SandboxClient {
  getOrCreate(args: { name: string; options: SandboxCreateOptions }): Promise<ExecutableSandbox>;
  get(args: { sandboxId: string }): Promise<ExecutableSandbox | null>;
}
