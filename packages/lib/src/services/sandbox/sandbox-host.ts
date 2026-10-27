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
export type SandboxSubstrateSpec =
  | { kind: 'sprite'; size?: SandboxSize }
  /**
   * A LOCAL environment — the user's own computer, reached over the zero-trust
   * env bridge (Local Environments epic). There is no VM here and no size to
   * ask for: the hardware is whatever the user enrolled, and its owner's
   * daemon is the policy enforcement point (invariant 4). See
   * `sandbox-client/local-env-sandbox-host.ts`.
   */
  | { kind: 'local'; envId: string };

/**
 * What a substrate can actually DO, advertised by the handle rather than
 * assumed by the caller (invariant 12: no silent safety degradation).
 *
 * The point of declaring this is that `SandboxHandle` has one shape and two
 * substrates behind it, and the local one genuinely cannot serve seven of its
 * members. A caller that meets `false` here must REFUSE with a reason it can
 * name; the unsupported member itself throws {@link LocalEnvUnsupportedError}
 * rather than returning a degenerate value, because a degenerate value is a
 * lie a caller cannot detect — `listStreams()` answering `[]` tells a caller
 * "no shells are running", which is a statement about the machine, not about
 * this seam's reach.
 *
 * `false` never means "not yet". Local terminals are PERMANENTLY outside this
 * seam: the plan routes local PTYs through apps/realtime with a signed
 * apps/web proxy and an SSE return path (M2), never through
 * `SandboxHandle.stream`.
 */
export interface SandboxCapabilities {
  /** `exec` — run a command and collect its output. */
  readonly exec: boolean;
  /** `writeFiles` / `readFile`. */
  readonly fs: boolean;
  /** `stream` / `listStreams` / `killSession` — interactive PTY sessions on THIS seam. */
  readonly stream: boolean;
  /** `createCheckpoint` — a filesystem snapshot before a destructive agent batch. */
  readonly checkpoint: boolean;
  /** `urlInfo` / `powerState` / `setUrlAuth` — the dev-preview surface. */
  readonly preview: boolean;
  /** `services.*` — runtime-managed services. */
  readonly services: boolean;
}

/** Every member of {@link SandboxHandle} the Sprite backend serves — all of them. */
export const SPRITE_SANDBOX_CAPABILITIES: SandboxCapabilities = {
  exec: true,
  fs: true,
  stream: true,
  checkpoint: true,
  preview: true,
  services: true,
};

/**
 * What a LOCAL environment serves: exec and files, and nothing else.
 *
 * `checkpoint: false` is invariant 12 in one line — the machine is the user's
 * own computer and this seam has no way to snapshot its filesystem, so the
 * checkpoint-policy layer must fail CLOSED on it rather than run a destructive
 * batch unprotected. `stream: false` is permanent (M2 routes local PTYs
 * elsewhere); `preview`/`services` are Sprite platform surfaces with no local
 * analogue.
 */
export const LOCAL_ENV_SANDBOX_CAPABILITIES: SandboxCapabilities = {
  exec: true,
  fs: true,
  stream: false,
  checkpoint: false,
  preview: false,
  services: false,
};

/** The `SandboxHandle` / `SandboxHost` members a local environment cannot serve. */
export type LocalEnvUnsupportedOp =
  | 'stream'
  | 'listStreams'
  | 'killSession'
  | 'createCheckpoint'
  | 'services'
  | 'urlInfo'
  | 'powerState'
  | 'setUrlAuth';

/**
 * A caller reached a `SandboxHandle` member this substrate does not serve.
 *
 * Deliberately an ERROR carrying the op name, never a degenerate return
 * value — see {@link SandboxCapabilities}. A caller has two correct
 * responses and no third: consult `capabilities` first and refuse with its
 * own typed reason, or catch this and do the same. Swallowing it and
 * continuing is the silent degradation invariant 12 forbids.
 */
export class LocalEnvUnsupportedError extends Error {
  constructor(
    readonly op: LocalEnvUnsupportedOp,
    readonly envId: string,
  ) {
    super(`Local environment ${envId} does not support "${op}" — see SandboxCapabilities`);
    this.name = 'LocalEnvUnsupportedError';
  }
}

/**
 * A local environment was asked for a machine while its daemon holds no
 * authorized bridge socket on this replica.
 *
 * Distinct from a policy denial ON PURPOSE, and the distinction is the whole
 * value of the type: "your computer is not connected" is fixed by running
 * `pagespace env connect`, while "the machine owner's bind policy denied you"
 * is fixed by the OWNER, on a different machine, in a different place. A
 * caller that cannot tell them apart sends the user to debug the wrong layer.
 */
export class LocalEnvNotConnectedError extends Error {
  constructor(readonly envId: string) {
    super(`Local environment ${envId} has no connected machine`);
    this.name = 'LocalEnvNotConnectedError';
  }
}

/**
 * The scheme for a local environment's sandbox ADDRESS.
 *
 * A local env holds no `drive_envs.sandboxId` — invariant 9 keeps every Sprite
 * column NULL so the row is structurally invisible to reclaim and billing — but
 * the seam's existing callers address a machine by an opaque id string
 * (`SandboxHost.attach({ sandboxId })`, the tool runner's `reconnect`). So a
 * local machine gets an address that is DERIVED, never persisted: it exists
 * only inside a request, and nothing writes it to a column.
 */
const LOCAL_ENV_SANDBOX_ID_PREFIX = 'local-env:';

/** The derived, never-persisted address of a local environment's machine. */
export function localEnvSandboxId(envId: string): string {
  return `${LOCAL_ENV_SANDBOX_ID_PREFIX}${envId}`;
}

/** The envId inside a local address, or null for any other id (a Sprite name). */
export function parseLocalEnvSandboxId(sandboxId: string): string | null {
  if (!sandboxId.startsWith(LOCAL_ENV_SANDBOX_ID_PREFIX)) return null;
  const envId = sandboxId.slice(LOCAL_ENV_SANDBOX_ID_PREFIX.length);
  return envId.length > 0 ? envId : null;
}

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
 * A control-plane READ did not answer in time — listing a sandbox's services,
 * or resolving the sandbox itself.
 *
 * Only reads raise this, and that asymmetry is the whole design. These calls
 * run inside a per-holder advisory lock (`dev-preview-lock.ts`), and the SDK
 * exposes no `AbortSignal`, so the best available bound is to stop WAITING —
 * the request itself keeps running until the runtime drops it. For a read
 * that is free: nothing was mutated, so abandoning the wait costs only the
 * work already done, and it releases a Postgres connection from a pool of 10
 * that every advisory-lock consumer shares.
 *
 * A MUTATION is deliberately NOT bounded this way. Abandoning the wait there
 * would release the lock while the create/start/stop is still in flight,
 * letting the next holder plan against a sprite that is about to change under
 * it — exactly the interleaving the lock exists to prevent. A hung mutation
 * still pins its connection; bounding it honestly needs cancellation the SDK
 * does not offer.
 */
export class SandboxControlPlaneTimeoutError extends Error {
  constructor(public readonly operation: string, public readonly timeoutMs: number) {
    super(`Sandbox control-plane read '${operation}' did not answer within ${timeoutMs}ms`);
    this.name = 'SandboxControlPlaneTimeoutError';
  }
}

/**
 * A port lifecycle notification observed on a machine's interactive stream —
 * a process inside the sandbox bound (or released) a TCP port. Data only:
 * whether that port is a dev server, whether it should be exposed, and what to
 * tell the user are all decisions for a consumer (the dev-preview decision
 * core), never for the transport that reports it.
 *
 * Provider caveats (Sprite, live-verified — see
 * docs/spikes/2026-08-dev-preview-sprite-services-spike.md §5): notifications
 * arrive only on TTY streams (a non-TTY exec running the same server emits
 * nothing), and `port_closed` has never been observed on the wire — treat it
 * as best-effort, never as a teardown signal.
 */
export interface SandboxPortEvent {
  type: 'port_opened' | 'port_closed';
  port: number;
  address?: string;
  pid?: number;
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
  /**
   * Subscribe to port open/close notifications on this stream (see
   * {@link SandboxPortEvent} for what arrives and the provider caveats).
   * Purely additive data: a caller that never subscribes sees no change.
   */
  onPortEvent(listener: (event: SandboxPortEvent) => void): void;
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

/**
 * A machine service's runtime status, provider-neutral. Mirrors the Sprite
 * wire union plus `'unknown'` for a status string a future backend/SDK bump
 * reports that this seam does not recognize — normalized at the driver edge
 * (never a lie, never a crash).
 *
 * Semantics caveat (live-verified): on Sprite, an explicit stop records
 * `'failed'` ("exited with code 143"), and the documented sticky `'stopped'`
 * was never observed — so status alone cannot distinguish "the user stopped
 * this" from "this crashed". Stopped-intent is the caller's to persist (the
 * old design doc's `stoppedByUser`, unchanged by the rebuild).
 */
export type SandboxServiceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed' | 'unknown';

/** A runtime-managed service on a machine, with its current state. */
export interface SandboxServiceInfo {
  name: string;
  command: string;
  args: string[];
  /**
   * The port the service DECLARED. Live-verified to have NO routing effect on
   * Sprite today (the machine URL always proxies to port 8080) — carried as
   * data for display/bookkeeping, never as proof of reachability.
   */
  httpPort?: number;
  status: SandboxServiceStatus;
  pid?: number;
  /** Failure text when status is `failed` — including after an explicit stop. */
  error?: string;
}

/** Arguments for creating (or updating — create is idempotent on `name`) a service. */
export interface CreateSandboxServiceArgs {
  name: string;
  command: string;
  args?: string[];
  httpPort?: number;
}

/**
 * Auth mode on the machine's inbound URL. `'sprite'` = platform-authenticated
 * (org token only; anonymous requests get an SSO redirect); `'public'` = no
 * auth; `'unknown'` = the backend reported a mode this seam does not
 * recognize — consumers MUST treat it as "not proven private" (fail closed),
 * never as private-by-default.
 */
export type SandboxUrlAuth = 'public' | 'sprite' | 'unknown';

/** The machine's inbound URL and its auth mode. `url: null` when the backend
 *  reports none. */
export interface SandboxUrlInfo {
  url: string | null;
  auth: SandboxUrlAuth;
}

/**
 * Whether the machine is currently awake, provider-neutral. `'running'` = a
 * request reaches it without waking anything; `'paused'` = hibernated (Sprite
 * `warm`/`cold`), so an inbound URL request, an exec, or a stream open WAKES
 * it — and a wake is billed (spike §6); `'unknown'` = the backend reported
 * nothing this seam recognizes. Consumers MUST treat `'unknown'` as "might be
 * a wake" (fail closed on the billing question), never as awake.
 */
export type SandboxPowerState = 'running' | 'paused' | 'unknown';

/**
 * Runtime-managed services on a machine (dev servers — the preview workstream;
 * agent terminals stay exec sessions, per the standing design decision).
 * Verified operations only; every mutation resolves after the backend's own
 * operation log stream completes, so a resolved promise means the operation
 * landed, not merely that a request was accepted.
 */
export interface SandboxServicesApi {
  /** Create-or-update AND auto-start the service (backend behavior — verified). */
  create(args: CreateSandboxServiceArgs): Promise<void>;
  list(): Promise<SandboxServiceInfo[]>;
  /** null for a name the machine has no service under (derived from list —
   *  the backend's get-by-name rejects with an untyped error on a miss). */
  get(name: string): Promise<SandboxServiceInfo | null>;
  start(name: string): Promise<void>;
  /** Sticky stop — nothing restarts it. See {@link SandboxServiceStatus} for
   *  the `failed`-not-`stopped` state it records. */
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** A provisioned/attached machine session — the full surface a caller drives. */
export interface SandboxHandle {
  /**
   * What this substrate can actually serve — read it BEFORE driving a member
   * that a second backend might not have (see {@link SandboxCapabilities}).
   * Required, not optional, for the same reason `createCheckpoint` is: a
   * caller that could not tell whether a handle had declared its capabilities
   * would have to guess, and the safe guess (assume nothing works) would break
   * the Sprite path while the unsafe one (assume everything works) is exactly
   * the silent degradation this field exists to stop.
   */
  readonly capabilities: SandboxCapabilities;
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
  /**
   * Runtime-managed services on this machine — see {@link SandboxServicesApi}.
   * Required, not optional, for the same reason `createCheckpoint` is: one
   * backend exists, and an optional-with-fallback would guard a hypothetical.
   */
  services: SandboxServicesApi;
  /**
   * The machine's inbound URL + auth mode, as last read from the control
   * plane. On the Sprite backend the fields ride the (per-connect cached)
   * sprite handle, so a `setUrlAuth` in the same connect may not be reflected
   * until the next attach — read it BEFORE mutating, or re-attach to confirm.
   */
  urlInfo(): Promise<SandboxUrlInfo>;
  /**
   * The machine's power state, as a CONTROL-PLANE read that does not wake it
   * (see {@link SandboxPowerState}). The dev-preview proxy asks this before
   * forwarding: a request to a `'paused'` machine is a wake, and the wake is
   * gated on the same code-execution posture as a session ensure. Same
   * per-call `getSprite` pattern as `urlInfo`.
   */
  powerState(): Promise<SandboxPowerState>;
  /**
   * Set the machine URL's auth mode. This is a CAPABILITY, not a policy:
   * v1 preview keeps every machine on `'sprite'` (org-token-only), and the
   * decision to ever go `'public'` belongs to a permission-gated decision
   * core, not to any caller of this seam directly. `'unknown'` is
   * deliberately not accepted here — only the two modes the platform verifies.
   */
  setUrlAuth(auth: 'public' | 'sprite'): Promise<void>;
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
