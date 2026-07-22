/**
 * Agent-terminal access, split into two jobs the fused
 * `makeAgentTerminalCheckAuth` used to run inline:
 *
 *   (a) DECIDING whether the user may attach — a pure decision over plain data
 *       gathered from the DB (`decideAgentTerminalAccess`), and
 *   (b) RESOLVING the Sprite for a fresh PTY — `resolveMachineSandbox`, which
 *       only runs once the access decision has already allowed.
 *
 * The split matters because a Sprite is woken automatically by any exec
 * (docs.sprites.dev/concepts/lifecycle) — deciding authorization never needs to
 * touch, resolve or wake it. So the access half performs ZERO sprite SDK calls,
 * and the re-auth interval (leaf 3-1) can re-check authorization on a live
 * session by gathering inputs + calling the pure decision alone, without
 * re-resolving or re-waking the Sprite it's already attached to.
 *
 * `buildAgentTerminalCheckAuth` composes both halves back into the
 * `AgentTerminalCheckAuthFn` the realtime PTY bridge consumes, with every IO
 * dependency injected so the shell is testable with fakes and the pure core is
 * testable with none.
 */

import { isPtyAgentType, resolveAgentLaunchSpec, type AgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';
import type { ResolveAgentTerminalResult } from '@pagespace/lib/services/machines/agent-terminals';
import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import type { AgentTerminalCheckAuthFn } from './agent-terminal-handler';

// ---------------------------------------------------------------------------
// (a) Pure access decision
// ---------------------------------------------------------------------------

/** The plain data the access decision reads — every field is a value the shell
 * has already gathered (a DB row, a `canRunCode` verdict, a slot-acquire
 * result), never a live handle or SDK client. */
export interface AgentTerminalAccessInputs {
  /** The caller's access level on the owning Machine page, or null/undefined if none. */
  access: { canEdit: boolean } | null | undefined;
  /** The Machine page row (only its driveId matters here), or null/undefined if it does not exist. */
  pageRow: { driveId: string } | null | undefined;
  /** The `canRunCode` verdict for this drive. */
  codeAuth: { ok: true } | { ok: false; reason: string };
  /** The owning drive row (only its ownerId — the payer — matters here), or null/undefined if it does not exist. */
  driveRow: { ownerId: string } | null | undefined;
  /** Whether a concurrency slot was actually reserved for this attach. */
  slotAcquired: boolean;
}

export type AgentTerminalAccessDecision =
  /** On allow, the two derived values every caller needs, surfaced so the shell
   * gets them already narrowed (they are guaranteed present past this point). */
  | { allow: true; driveId: string; payerId: string }
  | { allow: false; reason: string };

/**
 * Pure: decide whether an agent-terminal attach is authorized, in the SAME gate
 * order the fused checkAuth used — edit access, page existence, code-execution
 * permission, drive existence, then concurrency-slot availability. The first
 * failing gate's reason is returned; each maps byte-for-byte to the deny
 * `reason` the socket surface already emits.
 */
export function decideAgentTerminalAccess(inputs: AgentTerminalAccessInputs): AgentTerminalAccessDecision {
  if (!inputs.access?.canEdit) return { allow: false, reason: 'no_edit_access' };
  if (!inputs.pageRow) return { allow: false, reason: 'page_not_found' };
  if (!inputs.codeAuth.ok) return { allow: false, reason: inputs.codeAuth.reason };
  if (!inputs.driveRow) return { allow: false, reason: 'drive_not_found' };
  if (!inputs.slotAcquired) return { allow: false, reason: 'concurrency_limit' };
  return { allow: true, driveId: inputs.pageRow.driveId, payerId: inputs.driveRow.ownerId };
}

// ---------------------------------------------------------------------------
// (b) Lazy sprite resolution — runs ONLY for fresh PTY creation
// ---------------------------------------------------------------------------

export interface ResolveMachineSandboxTarget {
  machineId: string;
  projectName?: string;
  branchName?: string;
  name: string;
}

export interface ResolveMachineSandboxDeps {
  /** Resolve the named agent terminal to its Sprite + cwd + launch metadata. */
  resolveAgentTerminal: (target: ResolveMachineSandboxTarget) => Promise<ResolveAgentTerminalResult>;
  /**
   * Read the resolved Sprite handle. Called exactly once here — and the caller
   * (`apps/realtime/src/index.ts`) backs this with a per-connect
   * `createSpriteHandleCache` shared with the machine acquire above, so the
   * WHOLE connect (acquire + auth + launch resolution) costs ONE underlying
   * `sdk.getSprite`, not three.
   */
  getSprite: (sandboxId: string) => Promise<SpriteInstanceLike>;
  /**
   * OWN-SPRITE scopes only — a branch, or a PROMOTED project (issue #2204
   * phase 7) — never a machine-scope target or an UNPROMOTED project, which
   * run ON the root Sprite and already have its credential: refresh that
   * Sprite's Claude Code credential from the root Machine's Sprite before
   * handing back a fresh PTY resolution. This is the actual attach path a
   * user's node-scoped agent terminal goes through — `spawnBranch`/
   * `attachBranch` (`machine-branches.ts`) and `promoteProject`
   * (`machine-project-promotion.ts`) only cover creation/promotion and the
   * navigator's explicit attach API, none of which this realtime PTY bridge
   * calls.
   *
   * Optional so tests that don't exercise branch scope (or don't care about
   * credential propagation) can omit it. Awaited by `resolveMachineSandbox`,
   * but bounded by `CREDENTIAL_REFRESH_TIMEOUT_MS` (`withTimeout`) rather
   * than either fully blocking or fire-and-forget — see the inline comment
   * at that call site for why both extremes were tried and reverted. MUST
   * still be best-effort on the implementation side — swallow its own
   * failures — as defense in depth against an unhandled rejection.
   */
  refreshBranchCredential?: (args: { machineId: string; sandboxId: string }) => Promise<void>;
}

/**
 * Hard cap on how long `refreshBranchCredential` may delay a fresh branch
 * PTY open. Long enough for the common case (warm root + branch Sprite,
 * normally well under a second) to complete reliably; short enough that a
 * cold/hibernating Sprite's fs-timeout tail (up to ~60s, see the doc comment
 * on `machine-branches.ts`'s `propagateClaudeCredential`) never turns into a
 * near-minute-long terminal-open stall.
 */
const CREDENTIAL_REFRESH_TIMEOUT_MS = 5_000;

/** Resolve once `promise` settles OR `timeoutMs` elapses, whichever first — never rejects. The timer is always cleared, and `promise` keeps running past the bound rather than being cancelled (a slow settle still lands, just too late to have been waited on). */
function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

export type ResolveMachineSandboxResult =
  | {
      ok: true;
      agentTerminalId: string;
      sandboxId: string;
      cwd: string;
      /** The agentType's resolved launch command (the `'shell'` sentinel until the PTY layer resolves it to $SHELL). */
      command: string;
      args: string[];
      /** A per-terminal program override, or null. */
      commandOverride: string | null;
      streamSessionId: string | null;
      sprite: SpriteInstanceLike;
    }
  /** `sandboxId` is present only on the `provision_failed` (getSprite threw)
   * path, so the shell can log it exactly as the fused checkAuth did. */
  | { ok: false; reason: string; sandboxId?: string };

/**
 * Resolve the Sprite a FRESH PTY will attach to: resolve the agent-terminal row
 * to its sandbox, then read that Sprite once. A read-only resolve failure never
 * touches the Sprite; a chat-surface agentType (e.g. `pagespace`) denies with
 * `not_a_pty_agent` before the Sprite is touched; a vanished Sprite (getSprite
 * throws) denies with `provision_failed`.
 */
export async function resolveMachineSandbox(
  target: ResolveMachineSandboxTarget,
  deps: ResolveMachineSandboxDeps,
): Promise<ResolveMachineSandboxResult> {
  const resolved = await deps.resolveAgentTerminal(target);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  // Belt-and-suspenders over the socket layer's own `not_a_pty_agent` deny: a
  // buggy client emitting `agent-terminal:connect` for a chat-surface
  // (`pagespace`) session must be refused here too, before ever touching the
  // Sprite — the socket deny path and this one share the same reason string.
  if (!isPtyAgentType(resolved.agentType)) return { ok: false, reason: 'not_a_pty_agent' };

  const spec = resolveAgentLaunchSpec(resolved.agentType);

  let sprite: SpriteInstanceLike;
  try {
    sprite = await deps.getSprite(resolved.sandboxId);
  } catch {
    return { ok: false, reason: 'provision_failed', sandboxId: resolved.sandboxId };
  }

  // Keyed on the RESOLUTION, not on the shape of the target. The old gate
  // ("both projectName and branchName are set") could only ever describe a
  // branch, and there is no target shape that distinguishes a promoted project
  // from an unpromoted one — only the resolver knows, and it now says so
  // (`ownSprite`). A promoted project's Sprite is as credential-less as a
  // freshly spawned branch's, so it needs exactly the same refresh; an
  // unpromoted project still resolves to the root Sprite and must NOT trigger
  // one (it would copy the root's credential onto itself).
  if (resolved.ownSprite && deps.refreshBranchCredential) {
    // Awaited, but bounded — NOT fire-and-forget (tried that, reverted: a
    // fresh branch-scoped Claude terminal calls `openShell` with `claude`
    // immediately after this resolves, and copying the credential moments
    // later does nothing for a process that already started without it —
    // see review history). Also NOT unbounded: a cold/hibernating Sprite's
    // fs read/write can take up to the Sprite fs API's 30s timeout, WITH one
    // retry (so up to ~60s), and blocking every branch PTY open on that
    // would regress this codebase's Sprite invariant that opening a PTY is
    // itself the wake and nothing upstream waits long on it. The bound
    // covers the common case (warm root + branch Sprite, sub-second)
    // reliably while capping the cold-Sprite worst case to a few seconds —
    // still slower than ideal, but nowhere near a minute-long stall. The
    // refresh keeps running past the bound rather than being cancelled — a
    // slow copy still lands, just too late to help THIS launch.
    await withTimeout(
      deps.refreshBranchCredential({ machineId: target.machineId, sandboxId: resolved.sandboxId }),
      CREDENTIAL_REFRESH_TIMEOUT_MS,
    );
  }

  return {
    ok: true,
    agentTerminalId: resolved.agentTerminalId,
    sandboxId: resolved.sandboxId,
    cwd: resolved.cwd,
    command: spec.command,
    args: spec.args,
    commandOverride: resolved.command,
    streamSessionId: resolved.streamSessionId,
    sprite,
  };
}

// ---------------------------------------------------------------------------
// Composition — the checkAuth the PTY bridge consumes
// ---------------------------------------------------------------------------

export interface AgentTerminalCheckAuthDeps {
  getAccessLevel: (userId: string, machineId: string) => Promise<{ canEdit: boolean } | null>;
  getPageDriveId: (machineId: string) => Promise<{ driveId: string } | undefined>;
  canRunCode: (args: { userId: string; driveId: string; requestOrigin: 'user' }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  getDriveAndUser: (args: { driveId: string; userId: string }) => Promise<{
    driveRow: { ownerId: string } | undefined;
    userRow: { subscriptionTier: string | null; email: string | null } | undefined;
  }>;
  resolveActorEmail: (email: string | null | undefined) => Promise<string>;
  acquireSlot: (args: { userId: string; tier: SubscriptionTier }) => boolean;
  releaseSlot: (userId: string) => void;
  resolveSandbox: (target: ResolveMachineSandboxTarget & { userId: string }) => Promise<ResolveMachineSandboxResult>;
  /**
   * DB-only existence check for the (scope, name) target — resolves the branch/
   * project scope rows and the agent-terminal row itself, touching NO Sprite.
   * Part of the ACCESS half precisely because it is cheap: authorization must
   * keep noticing that a terminal's project/branch/row was deleted, and the 60s
   * re-auth tick (which never resolves a sandbox) is the only thing that will.
   *
   * Surfaces `agentType` on success — unlike `resolveAgentTerminal`, resolving
   * this row's SCOPE (`resolveScopeKey`) never touches `machineSandbox.acquire`
   * even for machine/project scope, so this is the earliest point a chat-surface
   * (`pagespace`) row can be denied `not_a_pty_agent` WITHOUT first waking or
   * reprovisioning the Machine's Sprite — `resolveMachineSandbox`'s own guard
   * runs too late for that (it only sees the row after `resolveAgentTerminal`
   * has already resolved the Sprite's location via `machineSandbox.acquire`).
   */
  resolveMachineRow: (target: ResolveMachineSandboxTarget) => Promise<{ ok: true; agentType: AgentRuntimeType } | { ok: false; reason: string }>;
  writeAudit: (input: { userId: string; actorEmail: string; driveId: string; command: string }) => void;
  buildSessionKey: (args: { machineId: string; projectName?: string; branchName?: string; name: string }) => string;
  logDenied: (reason: string, context: Record<string, unknown>) => void;
  logSandboxLookupFailed: (context: Record<string, unknown>) => void;
}

/**
 * Compose the two halves into the `AgentTerminalCheckAuthFn` the realtime PTY
 * bridge consumes. The access half (gather inputs -> `decideAgentTerminalAccess`)
 * runs first and touches no Sprite; the sprite half is handed back UNCALLED, as
 * a `resolveSandbox` thunk.
 *
 * Returning the sprite half lazily (rather than awaiting it here) is what lets
 * `onConnect` reattach a live in-memory session — a tab-back inside the 30-min
 * detached grace — on the strength of the access verdict alone (leaf 1-3): it
 * simply never calls the thunk, so no Sprite is resolved or woken and no audit
 * row is written for a session that already exists. Only the cold, create path
 * calls it.
 */
export function buildAgentTerminalCheckAuth(deps: AgentTerminalCheckAuthDeps): AgentTerminalCheckAuthFn {
  return async ({ userId, machineId, projectName, branchName, name }) => {
    // Gather the read-only inputs, short-circuiting I/O exactly as the fused
    // checkAuth did: no page read without edit access, and no drive/user read
    // once code execution is denied. This keeps a denied attach from issuing DB
    // round-trips it would then ignore — and, more importantly, keeps a
    // transient DB error on a downstream table from turning a clean, specific
    // denial (e.g. code_execution_disabled) into a thrown generic connection
    // error. `getDriveAndUser` batches its two reads internally.
    const access = await deps.getAccessLevel(userId, machineId);
    const pageRow = access?.canEdit ? await deps.getPageDriveId(machineId) : undefined;
    const codeAuth: { ok: true } | { ok: false; reason: string } = pageRow
      ? await deps.canRunCode({ userId, driveId: pageRow.driveId, requestOrigin: 'user' })
      : { ok: false, reason: 'page_not_found' };
    const { driveRow, userRow } =
      pageRow && codeAuth.ok
        ? await deps.getDriveAndUser({ driveId: pageRow.driveId, userId })
        : { driveRow: undefined, userRow: undefined };

    // Read-only gates first, WITHOUT reserving a slot. The slot is a RESERVATION
    // (handled below), not a read, so a read-only denial never reserves — and
    // then has to release — one; passing slotAcquired:true isolates that
    // read-only verdict (the slot is the pure decision's final gate).
    const readOnly = decideAgentTerminalAccess({ access, pageRow, codeAuth, driveRow, slotAcquired: true });
    if (!readOnly.allow) {
      deps.logDenied(readOnly.reason, { userId, machineId });
      return { ok: false, reason: readOnly.reason };
    }

    // The TARGET must still exist, not just the machine page. A DB-only check —
    // it resolves the branch/project scope rows and the agent-terminal row, and
    // wakes no Sprite — so it belongs in the access half even though the fused
    // checkAuth only ever learned this as a side effect of resolving the sandbox.
    //
    // Keeping it here is load-bearing: the 60s re-auth tick calls ONLY this half.
    // If the existence check lived behind the lazy sandbox thunk, deleting a
    // terminal's project (or branch, or the row itself) would stop being noticed
    // by re-auth at all, and the orphaned PTY would keep running against a scope
    // that no longer exists. The fused check caught that — at the cost of waking
    // the Sprite every 60 seconds, which is exactly what this epic is removing.
    const machineRow = await deps.resolveMachineRow({ machineId, projectName, branchName, name });
    if (!machineRow.ok) {
      deps.logDenied(machineRow.reason, { userId, machineId, projectName, branchName, name });
      return { ok: false, reason: machineRow.reason };
    }

    // Belt-and-suspenders over the socket layer's own `not_a_pty_agent` deny,
    // enforced HERE (not only in `resolveMachineSandbox`) because this is the
    // earliest point the row's agentType is known WITHOUT having already
    // acquired (and possibly woken/reprovisioned) the machine/project scope's
    // Sprite — that acquisition happens inside `resolveAgentTerminal`, which
    // the lazy `resolveSandbox` thunk below only calls for pty-surface rows.
    if (!isPtyAgentType(machineRow.agentType)) {
      deps.logDenied('not_a_pty_agent', { userId, machineId, projectName, branchName, name });
      return { ok: false, reason: 'not_a_pty_agent' };
    }

    // Decrypt the actor email BEFORE anything is reserved (a decrypt throw here
    // must not leak a reserved slot — same ordering the fused checkAuth had).
    const tier = (userRow?.subscriptionTier ?? 'free') as SubscriptionTier;
    const actorEmail = await deps.resolveActorEmail(userRow?.email);

    return {
      ok: true,
      // Derived from the (scope, name) target alone — no Sprite needed (leaf
      // 1-1), which is precisely what lets the caller look up a live session
      // before deciding whether any sandbox work is warranted at all.
      sessionKey: deps.buildSessionKey({ machineId: machineId, projectName, branchName, name }),
      payerId: readOnly.payerId,

      /**
       * Resolve/read the Sprite for a FRESH PTY — called by the cold path only.
       *
       * RESERVES the concurrency slot, because the slot exists to bound how many
       * PTYs a user has RUNNING — and only this path starts one. Reserving it in
       * the access half instead (as the fused checkAuth did) made a slot a
       * precondition for merely *asking* whether you may attach, which is wrong
       * in two ways that both bite the common case:
       *
       *   - A free-tier user (limit 1) with one live session could never reattach
       *     to it: their own session holds the only slot, so the tab-back's
       *     access check failed to acquire a second one and was denied
       *     `concurrency_limit`.
       *   - The 60s re-auth tick calls checkAuth on a LIVE session. It too failed
       *     to acquire a slot at the limit, read that as a lost authorization,
       *     and tore the session down — killing a free-tier PTY ~60s after it
       *     opened.
       *
       * Neither path starts a PTY, so neither needs a slot. Now they take none,
       * and `releaseSlot` is surfaced on the SUCCESS result only — there is no
       * slot to release unless this thunk actually reserved one.
       *
       * Owns slot release on its own failure paths: a deny releases and logs
       * before returning; a REJECT (a DB error inside resolveAgentTerminal, a
       * failed store/SDK lookup) releases before the rejection propagates, so a
       * transient failure can never permanently consume the user's concurrency
       * capacity. Re-throws so the socket surface is unchanged (the PTY bridge's
       * onConnect .catch emits the generic error).
       *
       * The audit row is written HERE rather than in the access half, because it
       * records a session actually being launched — a reattach to an already
       * running PTY launches nothing and must not write one.
       */
      resolveSandbox: async () => {
        // The pure decision's final gate (`slotAcquired`), enforced at the only
        // point a slot is genuinely needed. Nothing to release on failure —
        // acquireSlot reserved nothing.
        if (!deps.acquireSlot({ userId, tier })) {
          deps.logDenied('concurrency_limit', { userId, machineId });
          return { ok: false, reason: 'concurrency_limit' };
        }
        const releaseSlot = () => deps.releaseSlot(userId);

        let sandbox: ResolveMachineSandboxResult;
        try {
          sandbox = await deps.resolveSandbox({ userId, machineId, projectName, branchName, name });
        } catch (error) {
          releaseSlot();
          throw error;
        }
        if (!sandbox.ok) {
          releaseSlot();
          if (sandbox.reason === 'provision_failed') {
            deps.logSandboxLookupFailed({ userId, sandboxId: sandbox.sandboxId });
          } else {
            deps.logDenied(sandbox.reason, { userId, machineId, projectName, branchName, name });
          }
          return { ok: false, reason: sandbox.reason };
        }

        deps.writeAudit({
          userId,
          actorEmail,
          driveId: readOnly.driveId,
          command: sandbox.commandOverride ?? sandbox.command,
        });

        return {
          ok: true,
          agentTerminalId: sandbox.agentTerminalId,
          sandboxId: sandbox.sandboxId,
          cwd: sandbox.cwd,
          sprite: sandbox.sprite,
          command: sandbox.command,
          args: sandbox.args,
          commandOverride: sandbox.commandOverride,
          streamSessionId: sandbox.streamSessionId,
          releaseSlot,
        };
      },
    };
  };
}
