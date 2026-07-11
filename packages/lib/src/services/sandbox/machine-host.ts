/**
 * Machine substrate seam (Terminal Epic 2, T2.1 — machine-substrate abstraction).
 *
 * "Machine = a Sprite" today (tasks/terminal.md): a Fly Sprite's persistent
 * filesystem is why installed tools stick across hibernate/wake. Modal (or any
 * other GPU/"beefy" backend) is only ever a FUTURE option — this file exists so
 * that option costs nothing to add later, not to introduce a second backend now.
 *
 * `MachineHost` is the ONE coupling point between a caller (agent tool runner,
 * Terminal page, realtime PTY bridge) and whatever actually runs a machine. A
 * caller provisions/attaches/kills a `MachineHandle` and drives it — it never
 * imports `@fly/sprites`, `SpriteInstanceLike`, or any other provider type. To
 * add a second backend: extend `MachineSubstrateSpec` with a new `kind` member
 * and write one new `MachineHost` implementation for it (see
 * `sandbox-client/sprite-machine-host.ts` for the Sprite one) — no existing
 * `MachineHost` caller changes, because none of them branch on `kind`.
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
export type MachineSize = 'small' | 'beefy';

/**
 * Which backend provisions a machine, plus its declared size. A discriminated
 * union so a second backend adds a new `kind` member here (and nowhere else a
 * `MachineHost` caller can see) — see the file header.
 */
export type MachineSubstrateSpec = { kind: 'sprite'; size?: MachineSize };

/** Options for opening (or reattaching to) an interactive PTY stream on a machine. */
export interface MachineStreamOptions {
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

/** A machine's interactive-stream session, as reported by `MachineHandle.listStreams`. */
export interface MachineStreamSessionInfo {
  id: string;
  command: string;
  isActive: boolean;
}

/**
 * `stream()` waited the full wall-clock cap without the machine reporting EITHER
 * that the stream opened or that it failed.
 *
 * This is the "we genuinely do not know" outcome, and callers must treat it as
 * such. It is distinct from a stream that FAILED to open (a dangling session id
 * — the process is gone), because the two demand opposite responses: a failed
 * open means there is nothing left to kill, while a timeout may mean the process
 * is alive and merely unreachable, so tearing down its bookkeeping would orphan
 * it.
 */
export class MachineStreamOpenTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Machine stream did not open within ${timeoutMs}ms`);
    this.name = 'MachineStreamOpenTimeoutError';
  }
}

/**
 * POSITIVE evidence that the stream's target session no longer exists — the
 * machine answered, and its answer was "no such session" (a 404/410 on the exec
 * endpoint).
 *
 * This is the ONLY signal on which a caller may tear down a session's
 * bookkeeping. Every other failure — a control-plane blip, a 429, a 5xx during a
 * deploy, a socket hang-up, a timeout — is indistinguishable from "the process is
 * alive and we merely could not reach it", and acting on those would orphan a
 * running, billable PTY with nothing left pointing at it.
 *
 * The asymmetry is deliberate: keeping a row for a session that is already dead
 * is a visible, retryable annoyance; deleting the row for a session that is still
 * alive is a silent, unrecoverable leak. We bias to the former.
 */
export class MachineStreamSessionGoneError extends Error {
  /** `cause` is carried explicitly rather than via `new Error(msg, { cause })` — that overload needs an ES2022 lib, which not every consuming app targets. */
  constructor(public readonly sessionId: string, public readonly cause?: unknown) {
    super(`Machine stream session ${sessionId} no longer exists`);
    this.name = 'MachineStreamSessionGoneError';
  }
}

/**
 * A live interactive (PTY) stream on a machine. Deliberately minimal — bounded
 * reconnect/keepalive orchestration (see `apps/realtime/src/terminal/sprites-shell.ts`)
 * is caller-side policy, not part of this seam: a caller reconnects by calling
 * `MachineHandle.stream` again with the prior `sessionId`.
 */
export interface MachineStream {
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  onData(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code: number) => void): void;
  onError(listener: (error: unknown) => void): void;
  kill(signal?: string): void;
}

/** A provisioned/attached machine session — the full surface a caller drives. */
export interface MachineHandle {
  readonly machineId: string;
  exec(args: RunCommandArgs): Promise<SandboxRunResult>;
  writeFiles(files: WriteFileEntry[]): Promise<void>;
  readFile(args: { path: string }): Promise<Buffer | null>;
  stream(args: MachineStreamOptions): Promise<MachineStream>;
  listStreams(): Promise<MachineStreamSessionInfo[]>;
}

/**
 * The provider-neutral machine lifecycle seam. `provision` auto-resumes an
 * existing machine addressed by `name` (mirrors `ExecSandboxClient.getOrCreate`
 * — same name, same filesystem, back on the same machine); `attach` reconnects
 * to a known id (null if it has vanished); `kill` tears down.
 */
export interface MachineHost {
  provision(args: {
    name: string;
    substrate: MachineSubstrateSpec;
    options: SandboxCreateOptions;
  }): Promise<MachineHandle>;
  attach(args: { machineId: string }): Promise<MachineHandle | null>;
  kill(args: { machineId: string }): Promise<void>;
}
