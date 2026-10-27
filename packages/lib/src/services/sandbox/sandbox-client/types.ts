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
import type { SandboxCapabilities } from '../sandbox-host';

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
  /**
   * OPT-IN: resolve as soon as a stdout LINE begins with this token, instead
   * of waiting for the exec socket to close.
   *
   * Why this exists (measured 2026-09-08 against real sprites): the Sprites
   * runtime holds an exec WebSocket open for ~5s on a fresh sprite and ~10s
   * on a long-lived one AFTER the process has exited — even for `true` — and
   * the SDK delivers `exit` only when the socket closes. So every run through
   * this driver carries a 5–10s tail the command did not spend, and any cap
   * under that can never succeed. A caller whose command prints
   * `<sentinel> <exit-code>` as its last line gets its answer at first-byte
   * latency (~200ms); the driver reads the code from that line, stops
   * collecting, and SIGKILLs the lingering socket itself.
   *
   * Inert unless set. Callers that need the process's own exit (a long build,
   * a shell) keep the close-based contract untouched.
   */
  stdoutSentinel?: string;
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
  /**
   * What the substrate behind this sandbox can actually serve, carried across
   * from `SandboxHost`'s handle by `adaptSandboxHandleToExecutableSandbox`.
   *
   * OPTIONAL here, unlike on `SandboxHandle`, and the asymmetry is deliberate:
   * this interface predates the second substrate and is implemented by fakes
   * all over the test suite that describe a Sprite. Absent therefore means
   * "a sandbox built before capabilities existed" — i.e. the Sprite surface,
   * which is what every such implementation is. What must never happen is a
   * substrate that CANNOT do something leaving this absent: the local adapter
   * always sets it, and the checkpoint gate additionally treats the typed
   * `LocalEnvUnsupportedError` as a refusal, so neither net alone is trusted.
   */
  readonly capabilities?: SandboxCapabilities;
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
