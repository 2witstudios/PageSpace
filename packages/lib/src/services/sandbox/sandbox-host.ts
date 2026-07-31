/**
 * Sandbox-driver seam (originated as Terminal Epic 2, T2.1's machine-substrate
 * abstraction; kept and renamed post-rebuild as the provider-neutral seam every
 * sandbox provisioning path goes through).
 *
 * "Sandbox = a Sprite" today (tasks/terminal.md): a Fly Sprite's persistent
 * filesystem is why installed tools stick across hibernate/wake. Modal (or any
 * other GPU/"beefy" backend) is only ever a FUTURE option — this file exists so
 * that option costs nothing to add later, not to introduce a second backend now.
 *
 * `SandboxHost` is the ONE coupling point between a caller (agent tool runner,
 * Terminal page, realtime PTY bridge) and whatever actually runs a sandbox. A
 * caller provisions/attaches/kills a `SandboxHandle` and drives it — it never
 * imports `@fly/sprites`, `SpriteInstanceLike`, or any other provider type. To
 * add a second backend: extend `SandboxSubstrateSpec` with a new `kind` member
 * and write one new `SandboxHost` implementation for it (see
 * `sandbox-client/sprite-sandbox-host.ts` for the Sprite one) — no existing
 * `SandboxHost` caller changes, because none of them branch on `kind`.
 *
 * This module is pure types (no IO, no Sprite import) so it can be depended on
 * by both a caller and a driver without pulling either concrete backend in.
 */

import type { RunCommandArgs, SandboxRunResult, WriteFileEntry } from './sandbox-client/types';
import type { SandboxCreateOptions } from './sandbox-options';

/**
 * Resource tier a machine substrate declares. Only 'small' is backed by any
 * implementation today (every Sprite machine is 'small'); 'beefy' is reserved
 * for a future GPU/high-resource backend. Declaring it now means a caller can
 * request a size without knowing which backend will end up serving it.
 */
export type SandboxSize = 'small' | 'beefy';

/**
 * Which backend provisions a machine, plus its declared size. A discriminated
 * union so a second backend adds a new `kind` member here (and nowhere else a
 * `SandboxHost` caller can see) — see the file header.
 */
export type SandboxSubstrateSpec = { kind: 'sprite'; size?: SandboxSize };

/** Options for opening (or reattaching to) an interactive PTY stream on a machine. */
export interface SandboxStreamOptions {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Reattach to an existing stream session (survives a dropped connection) instead of starting a new shell. */
  sessionId?: string;
  /** Defaults to the backend's interactive shell (e.g. `bash`) when omitted. */
  command?: string;
  args?: string[];
}

/** A machine's interactive-stream session, as reported by `SandboxHandle.listStreams`. */
export interface SandboxStreamSessionInfo {
  id: string;
  command: string;
  isActive: boolean;
}

/**
 * `stream()` waited the full wall-clock cap without the machine reporting EITHER
 * that the stream opened or that it failed.
 *
 * This is the "we genuinely do not know" outcome, and it is distinct from a
 * stream that FAILED to open. A failure is an ANSWER — the caller can go on to
 * corroborate it (e.g. `killAgentTerminal` asks `listStreams()` whether the
 * session still exists). A timeout is the absence of one, from a machine that
 * would not answer at all for the full cap — so a caller must NOT go on to trust
 * that same machine's other answers. It should do nothing destructive and let a
 * retry settle it: the process may well be alive and merely unreachable, and
 * tearing down its bookkeeping would orphan it.
 */
export class SandboxStreamOpenTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Machine stream did not open within ${timeoutMs}ms`);
    this.name = 'SandboxStreamOpenTimeoutError';
  }
}

/**
 * A live interactive (PTY) stream on a machine. Deliberately minimal — bounded
 * reconnect/keepalive orchestration (see `apps/realtime/src/terminal/sprites-shell.ts`)
 * is caller-side policy, not part of this seam: a caller reconnects by calling
 * `SandboxHandle.stream` again with the prior `sessionId`.
 */
export interface SandboxStream {
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  onData(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code: number) => void): void;
  onError(listener: (error: unknown) => void): void;
  kill(signal?: string): void;
}

/**
 * A kill was asked to destroy one Sprite INSTANCE, but a DIFFERENT one holds that
 * name now — so the target is already gone and the newcomer is not ours to kill.
 *
 * Deliberately an ERROR rather than a quiet success. Callers treat a successful
 * kill as proof the VM is dead and release its last pointer; if their instance id
 * was stale, that release would strand the live VM standing at the name. Failing
 * keeps the pointer, so the worst case is a retry, never an orphan.
 */
export class SandboxSpriteReplacedError extends Error {
  constructor(
    readonly sandboxId: string,
    readonly expectedInstanceId: string,
    readonly actualInstanceId: string,
  ) {
    super(
      `Sprite "${sandboxId}" is now instance ${actualInstanceId}, not the ${expectedInstanceId} we were asked to kill — refusing to destroy a VM we did not target`,
    );
    this.name = 'SandboxSpriteReplacedError';
  }
}

/** A provisioned/attached machine session — the full surface a caller drives. */
export interface SandboxHandle {
  /**
   * The platform's id for this Sprite INSTANCE — the VM's actual identity, unique
   * per generation. `sandboxId` below is only the reused NAME, so anything that
   * must act on THIS VM (a kill, a CAS against a tracking row) keys on this.
   * Null when the driver could not report one.
   */
  spriteInstanceId: string | null;
  readonly sandboxId: string;
  /**
   * Proof of the egress lockdown confirmed for THIS VM, for the caller to persist
   * and hand back on the next provision (see `egress-lockdown.ts`). Undefined when
   * unproven — the caller then records nothing and the next hand-back re-applies.
   */
  readonly egressPolicyToken?: string;
  exec(args: RunCommandArgs): Promise<SandboxRunResult>;
  writeFiles(files: WriteFileEntry[]): Promise<void>;
  readFile(args: { path: string }): Promise<Buffer | null>;
  stream(args: SandboxStreamOptions): Promise<SandboxStream>;
  listStreams(): Promise<SandboxStreamSessionInfo[]>;
  /**
   * Terminate a specific interactive-stream session server-side, by id —
   * reaches a session regardless of whether the caller currently holds a live
   * `SandboxStream` to it (unlike `SandboxStream.kill()`, a signal delivered
   * over that stream's own transport, which reaches nothing once the
   * transport is closed or was never opened). This is what a genuine
   * termination (an explicit kill request, or the detached-idle reap) must
   * call — see `apps/realtime/src/terminal/sprites-shell.ts`'s
   * `planTeardown`.
   *
   * MUST be idempotent: killing an id the machine no longer recognizes
   * (already dead, or never existed) resolves successfully rather than
   * rejecting.
   */
  killSession(sessionId: string): Promise<void>;
  /**
   * Create a filesystem checkpoint tagged with `comment` (Sprites Platform
   * Alignment 5-2) — see `sprite-sandbox-host.ts` for the (today, only)
   * implementation. Required: `SandboxHost` has exactly one backend
   * (Sprite) as of this writing, so an optional-with-runtime-fallback here
   * would be a guard against a hypothetical future backend that does not
   * exist yet — code review on PR #2025 flagged that as premature
   * abstraction. Add it back as optional only when a second backend that
   * genuinely cannot support checkpoints is introduced.
   */
  createCheckpoint(comment: string): Promise<void>;
}

/**
 * The provider-neutral machine lifecycle seam. `provision` auto-resumes an
 * existing machine addressed by `name` (mirrors `ExecSandboxClient.getOrCreate`
 * — same name, same filesystem, back on the same machine); `attach` reconnects
 * to a known id (null if it has vanished); `kill` tears down.
 */
export interface SandboxHost {
  provision(args: {
    name: string;
    substrate: SandboxSubstrateSpec;
    options: SandboxCreateOptions;
    /**
     * The lockdown token recorded for this machine — proof that a policy was
     * applied to a specific VM instance (see `egress-lockdown.ts`). Absent, stale,
     * or naming a VM that has since been replaced → the backend re-applies the
     * lockdown; still valid → it skips the redundant push on a warm resume.
     */
    appliedEgressToken?: string | null;
  }): Promise<SandboxHandle>;
  attach(args: { sandboxId: string }): Promise<SandboxHandle | null>;
  /**
   * DESTROY the Sprite currently named `sandboxId`.
   *
   * `expectedInstanceId` is the identity guard, and it matters because the kill
   * is NAME-keyed (`deleteSprite(name)`) while a name is REUSED across
   * re-creates: without it, killing a Sprite that was destroyed and
   * re-provisioned under the same session key would destroy the REPLACEMENT —
   * someone's live VM. When supplied, the host verifies the VM currently holding
   * the name is the one we meant to kill, and treats "a different VM lives here
   * now" as success (our target is already gone) rather than destroying it.
   */
  kill(args: { sandboxId: string; expectedInstanceId?: string | null }): Promise<void>;
}
