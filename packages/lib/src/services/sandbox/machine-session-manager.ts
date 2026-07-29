import type { SandboxCreateOptions } from './sandbox-options';

/**
 * The foundational sandbox-driver contract (`SandboxHandle`/`SandboxClient`)
 * plus the session-key HMAC secret reader. Narrowed by the Phase 8 teardown:
 * this used to also own the `machine_sessions`-backed session-lifecycle
 * planner/store/acquire path (`planMachineLifecycle`, `acquireMachineSession`,
 * `deriveMachineSessionKey`, …) for the deleted Machine page type — that
 * table and its whole call chain are gone. `sandbox-client/types.ts` extends
 * the two interfaces below; `getSandboxSessionSecret` is still read by both
 * the web and realtime session-key derivations (`agent-sessions/session-sprite-key.ts`).
 */

/** Minimal sandbox handle the lifecycle needs. */
export interface SandboxHandle {
  /**
   * The Sprite's NAME — our own derived session key. Deliberately NOT an
   * identity: it is reused across re-creates, so a Sprite destroyed and
   * re-provisioned under the same key answers to the same `sandboxId` while
   * being a physically different VM (see `SpriteInstanceLike.id`). Anything that
   * needs to know WHICH VM must use `spriteInstanceId`.
   */
  sandboxId: string;
  /**
   * The platform's id for this Sprite INSTANCE — the actual identity, unique per
   * VM generation. Null when the platform reported none, in which case callers
   * fall back to comparing names and accept the ABA risk that implies.
   *
   * REQUIRED, deliberately: it was optional, and an adapter
   * (`adaptSandboxHandleToExecutableSandbox`) silently dropped it on the way from
   * `SandboxHandle` back to `ExecutableSandbox` — which is the production session
   * client. Every `machine_sessions` row therefore stored NULL, every identity
   * guard fell back to name-only, and the whole ABA protection was inert while
   * typechecking clean. A required field makes that a compile error.
   */
  spriteInstanceId: string | null;
  /**
   * Proof that this VM is running the egress policy the caller asked for — a
   * token over (Sprite instance id, policy hash); see `egress-lockdown.ts`. The
   * driver returns it once the lockdown is confirmed; the caller persists it and
   * hands it back as `appliedEgressToken` on the next connect, which is what lets
   * a warm resume skip the redundant policy push. Undefined = unproven (the `get`
   * path, or a platform that did not report the Sprite's identity) → record
   * nothing, and the next hand-back re-applies.
   */
  egressPolicyToken?: string;
}

export interface SandboxGetOrCreateArgs {
  name: string;
  options: SandboxCreateOptions;
  /**
   * The lockdown token persisted for this session — proof that a specific policy
   * was applied to a specific Sprite INSTANCE (see `egress-lockdown.ts`). The
   * driver re-applies the policy unless this still holds: absent (unknown → fail
   * closed), a changed policy, or a Sprite re-created under the same name (a new
   * VM, on the platform's default open egress, whose predecessor's proof must not
   * carry over). Otherwise it skips the control-plane round-trip, because the
   * policy file is persistent and survives hibernation.
   */
  appliedEgressToken?: string | null;
}

/**
 * The provider-agnostic slice of the sandbox client this layer drives, injected
 * so this lifecycle owns no execution path (the Fly Sprites driver implements
 * it). `getOrCreate` auto-resumes by `name` (the session key); `get` reconnects
 * to a known id (null if it has vanished); `stop` DESTROYS — see its own doc.
 */
export interface SandboxClient {
  getOrCreate(args: SandboxGetOrCreateArgs): Promise<SandboxHandle>;
  get(args: { sandboxId: string }): Promise<SandboxHandle | null>;
  /**
   * Irreversible DESTROY — files, installed packages, and checkpoints are gone,
   * with no undo (docs.sprites.dev/working-with-sprites). Call this ONLY for
   * genuine teardown intent (a Machine/branch delete, or cleaning up a Sprite
   * this process just failed to link to a session row) — NEVER as idle/billing
   * cleanup. A paused sandbox already stops compute billing on its own and costs
   * only bytes-written storage, so idleness alone is never a reason to call this.
   */
  stop(args: { sandboxId: string }): Promise<void>;
}

/**
 * Read the session-key secret. Returns '' (→ fail-closed deny) when unset, so a
 * missing secret disables sandbox acquisition rather than throwing at the call
 * site.
 *
 * Read directly from `process.env`, NOT via `getValidatedEnv()`: this runs in the
 * realtime service too (terminal session keys), whose lean env does not satisfy
 * the full web schema — `getValidatedEnv()` would throw there, blanking the
 * secret and denying every terminal.
 */
export function getSandboxSessionSecret(): string {
  const secret = process.env.SANDBOX_SESSION_SECRET ?? '';
  // The web schema enforces >=32 chars; realtime bypasses full validation, so guard
  // here — a too-short secret weakens the session-key HMAC. Treat it as unset
  // (fail-closed) rather than deriving keys from a weak secret.
  return secret.length >= 32 ? secret : '';
}
