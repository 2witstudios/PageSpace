/**
 * Shell access — the re-keyed successor to `agent-terminal-access.ts`, split
 * into the same two jobs:
 *
 *   (a) DECIDING whether the user may attach — resolved shell row → owning
 *       session → the ONE pure session access decision
 *       (`decideAgentSessionAccess`, via the injected `checkSessionAccess`
 *       seam that wraps `checkAgentSessionAccess` from packages/lib). No
 *       access branch is re-implemented here: web routes and this bridge
 *       cannot diverge because they call the same function.
 *   (b) RESOLVING the Sprite for a fresh PTY — the `resolveSandbox` thunk,
 *       which only runs once the access decision has already allowed, and
 *       which provisions through the SHARED `ensureAgentSessionSandbox`
 *       (injected — NEVER a realtime-local provisioner, or web and realtime
 *       would CAS-fight over one session's Sprite pointer).
 *
 * The split matters for the same reason it always did: deciding authorization
 * never touches, resolves or wakes a Sprite, so the 60s re-auth tick can
 * re-check a live session's authorization with DB reads alone — and a reattach
 * inside the 30-min detached grace is served on the strength of the access
 * verdict alone, because the sprite half is handed back UNCALLED.
 *
 * What the predecessor had that this does not: the `not_a_pty_agent` gates
 * (every shell is a PTY by construction — the chat-surface agent type has no
 * successor), the scope-row existence checks (a shell has exactly one row, and
 * its existence IS the address check), and the machine/drive/edit-access gate
 * chain (replaced wholesale by the session access decision).
 */

import { resolveShellLaunchSpec } from '@pagespace/lib/services/agent-workspaces/shell-types';
import type { AgentSessionAccessSubject } from '@pagespace/lib/agent-workspaces/decide-workspace-access';
import type { ShellDTO } from '@pagespace/lib/agent-workspaces/shells-contract';
import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import type { ShellCheckAuthFn } from './shell-handler';

/**
 * The injected session-access seam. The wiring backs this with
 * `checkAgentSessionAccess` (packages/lib) and hands back the session subject
 * it already read on allow, so the billing/tenant derivation below never
 * re-reads the row the decision was made over.
 */
export type ShellSessionAccessResult =
  | { allowed: true; session: AgentSessionAccessSubject }
  | { allowed: false; reason: string };

export interface ShellCheckAuthDeps {
  /**
   * DB-only shell row lookup (`resolveSessionShellById`) — resolves the wire
   * address to its row, cwd (always the sandbox home) and last-known Sprite
   * exec-session id. Touches NO Sprite. Part of the ACCESS half deliberately:
   * the 60s re-auth tick is the only thing that will notice a shell row
   * deleted out from under a live PTY, and it must afford this check.
   */
  resolveShell: (shellId: string) => Promise<
    | { ok: true; shell: ShellDTO; cwd: string; spriteExecId: string | null }
    | { ok: false; reason: 'not_found' }
  >;
  /** The ONE session access decision — `checkAgentSessionAccess` wired with real IO. DB-only, never wakes a Sprite. */
  checkSessionAccess: (input: { requesterId: string; workspaceId: string }) => Promise<ShellSessionAccessResult>;
  /**
   * Who pays for this session's runtime, and which drive an audit row lands
   * under. Payer = the session's own DRIVE owner, falling back to the
   * session's own owner when there is no drive (a global-assistant session)
   * or the drive has vanished — the drive-owner ?? session-owner attribution
   * rule.
   */
  resolvePayer: (session: AgentSessionAccessSubject) => Promise<{ payerId: string; driveId: string | null }>;
  /** A user row's tier + email, or undefined when the row is missing. Called for the requester (audit email) and, when different, the payer (slot-eligibility tier). */
  getUser: (userId: string) => Promise<{ subscriptionTier: string | null; email: string | null } | undefined>;
  resolveActorEmail: (email: string | null | undefined) => Promise<string>;
  acquireSlot: (args: { userId: string; tier: SubscriptionTier }) => boolean;
  releaseSlot: (userId: string) => void;
  /**
   * The SHARED provisioning path — `ensureAgentSessionSandbox` from
   * `packages/lib/src/services/agent-workspaces/agent-workspace-sprite.ts`, wired
   * with real deps by the caller. One code path with the web tier, so the CAS
   * inside it actually serializes concurrent provisioners.
   */
  ensureSessionSandbox: (input: { workspaceId: string; userId: string }) => Promise<
    | { ok: true; sandboxId: string }
    | { ok: false; reason: string }
  >;
  /** Read the resolved Sprite handle — called exactly once, on the cold path only. */
  getSprite: (sandboxId: string) => Promise<SpriteInstanceLike>;
  writeAudit: (input: { userId: string; actorEmail: string; driveId: string | null; command: string }) => void;
  buildSessionKey: (args: { shellId: string }) => string;
  logDenied: (reason: string, context: Record<string, unknown>) => void;
  logSandboxLookupFailed: (context: Record<string, unknown>) => void;
}

/**
 * Compose the two halves into the `ShellCheckAuthFn` the realtime PTY bridge
 * consumes. The access half (shell row → session access decision) runs first
 * and touches no Sprite; the sprite half is handed back UNCALLED, as a
 * `resolveSandbox` thunk.
 *
 * Returning the sprite half lazily (rather than awaiting it here) is what lets
 * `onConnect` reattach a live in-memory session — a tab-back inside the 30-min
 * detached grace — on the strength of the access verdict alone: it simply
 * never calls the thunk, so no Sprite is resolved or woken and no audit row is
 * written for a session that already exists. Only the cold, create path calls
 * it.
 */
export function buildShellCheckAuth(deps: ShellCheckAuthDeps): ShellCheckAuthFn {
  return async ({ userId, shellId }) => {
    // The row IS the address: an unresolvable shellId has nothing to authorize
    // against, so the lookup comes first. It leaks nothing a denial would not —
    // the id is an unguessable cuid, and the session decision downstream keeps
    // 404-vs-403 distinguishable exactly as the web routes do.
    const resolved = await deps.resolveShell(shellId);
    if (!resolved.ok) {
      deps.logDenied(resolved.reason, { userId, shellId });
      return { ok: false, reason: resolved.reason };
    }
    const { shell, cwd, spriteExecId } = resolved;

    // THE access decision — the same pure `decideAgentSessionAccess` verdict
    // the web API routes enforce, reached through the same IO wrapper. Nothing
    // here weighs the facts; it only carries the verdict.
    const access = await deps.checkSessionAccess({ requesterId: userId, workspaceId: shell.workspaceId });
    if (!access.allowed) {
      deps.logDenied(access.reason, { userId, shellId, workspaceId: shell.workspaceId });
      return { ok: false, reason: access.reason };
    }

    const { payerId, driveId } = await deps.resolvePayer(access.session);

    // Decrypt the actor email BEFORE anything is reserved (a decrypt throw here
    // must not leak a reserved slot — same ordering the predecessor had).
    const userRow = await deps.getUser(userId);
    // The slot-eligibility tier is the PAYER's, not the requester's (review
    // #2326): `acquireSlot` refuses free-tier outright (`isSandboxAvailable`)
    // and caps by tier, and a free-tier collaborator opening a shell in a
    // Pro-owned drive runs on the drive owner's plan. The slot itself is
    // still counted against the REQUESTER (`userId`), keeping per-actor
    // concurrency accounting separate from payer-based entitlement.
    const payerRow = payerId === userId ? userRow : await deps.getUser(payerId);
    const tier = (payerRow?.subscriptionTier ?? 'free') as SubscriptionTier;
    const actorEmail = await deps.resolveActorEmail(userRow?.email);

    return {
      ok: true,
      // Derived from the shellId alone — no Sprite needed, which is precisely
      // what lets the caller look up a live session before deciding whether
      // any sandbox work is warranted at all.
      sessionKey: deps.buildSessionKey({ shellId }),
      payerId,
      /** Billing attribution scope: the session's drive, or null for an owner-attributed global-assistant session. A session is not page-anchored, so there is no pageId to attribute. */
      driveId: access.session.driveId,

      /**
       * Reserve the concurrency slot and resolve the Sprite for a FRESH PTY —
       * called ONLY on the create path. Owns slot release on its own failure
       * paths: a deny releases and logs before returning; a REJECT releases
       * before the rejection propagates, so a transient failure can never
       * permanently consume the user's concurrency capacity. On success the
       * slot stays reserved and the caller owns it via `releaseSlot`.
       *
       * The audit row is written HERE rather than in the access half, because
       * it records a session actually being launched — a reattach to an
       * already running PTY launches nothing and must not write one.
       */
      resolveSandbox: async () => {
        // The final gate, enforced at the only point a slot is genuinely
        // needed. Nothing to release on failure — acquireSlot reserved nothing.
        if (!deps.acquireSlot({ userId, tier })) {
          deps.logDenied('concurrency_limit', { userId, shellId });
          return { ok: false, reason: 'concurrency_limit' };
        }
        const releaseSlot = () => deps.releaseSlot(userId);

        // The ONE shared provisioning path. If the session has no sandbox this
        // creates it; if it has one this resumes/adopts it — every branch of
        // that verdict lives in `plan-workspace-lifecycle.ts`, not here.
        let ensured: Awaited<ReturnType<ShellCheckAuthDeps['ensureSessionSandbox']>>;
        try {
          ensured = await deps.ensureSessionSandbox({ workspaceId: shell.workspaceId, userId });
        } catch (error) {
          releaseSlot();
          throw error;
        }
        if (!ensured.ok) {
          releaseSlot();
          deps.logDenied(ensured.reason, { userId, shellId, workspaceId: shell.workspaceId });
          return { ok: false, reason: ensured.reason };
        }

        let sprite: SpriteInstanceLike;
        try {
          sprite = await deps.getSprite(ensured.sandboxId);
        } catch {
          releaseSlot();
          deps.logSandboxLookupFailed({ userId, sandboxId: ensured.sandboxId });
          return { ok: false, reason: 'provision_failed', sandboxId: ensured.sandboxId };
        }

        const spec = resolveShellLaunchSpec(shell.agentType);

        deps.writeAudit({
          userId,
          actorEmail,
          driveId,
          command: shell.command ?? spec.command,
        });

        return {
          ok: true,
          shellId: shell.shellId,
          workspaceId: shell.workspaceId,
          sandboxId: ensured.sandboxId,
          cwd,
          sprite,
          command: spec.command,
          args: spec.args,
          commandOverride: shell.command,
          spriteExecId,
          releaseSlot,
        };
      },
    };
  };
}
