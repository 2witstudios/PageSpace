/**
 * Agent-terminal access, split into two jobs the fused
 * `makeAgentTerminalCheckAuth` used to run inline:
 *
 *   (a) DECIDING whether the user may attach — a pure decision over plain data
 *       gathered from the DB (`decideAgentTerminalAccess`), and
 *   (b) RESOLVING the Sprite for a fresh PTY — `resolveTerminalSandbox`, which
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

import { resolveAgentLaunchSpec } from '@pagespace/lib/services/machines/agent-terminal-types';
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

export interface ResolveTerminalSandboxTarget {
  machineId: string;
  projectName?: string;
  branchName?: string;
  name: string;
}

export interface ResolveTerminalSandboxDeps {
  /** Resolve the named agent terminal to its Sprite + cwd + launch metadata. */
  resolveAgentTerminal: (target: ResolveTerminalSandboxTarget) => Promise<ResolveAgentTerminalResult>;
  /** Read the resolved Sprite handle. Called EXACTLY ONCE here (full getSprite
   * collapse across resolve/wake is leaf 1-4). */
  getSprite: (sandboxId: string) => Promise<SpriteInstanceLike>;
}

export type ResolveTerminalSandboxResult =
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
 * touches the Sprite; a vanished Sprite (getSprite throws) denies with
 * `provision_failed`.
 */
export async function resolveTerminalSandbox(
  target: ResolveTerminalSandboxTarget,
  deps: ResolveTerminalSandboxDeps,
): Promise<ResolveTerminalSandboxResult> {
  const resolved = await deps.resolveAgentTerminal(target);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const spec = resolveAgentLaunchSpec(resolved.agentType);

  let sprite: SpriteInstanceLike;
  try {
    sprite = await deps.getSprite(resolved.sandboxId);
  } catch {
    return { ok: false, reason: 'provision_failed', sandboxId: resolved.sandboxId };
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
  resolveSandbox: (target: ResolveTerminalSandboxTarget & { userId: string }) => Promise<ResolveTerminalSandboxResult>;
  writeAudit: (input: { userId: string; actorEmail: string; driveId: string; command: string }) => void;
  buildSessionKey: (args: { terminalId: string; projectName?: string; branchName?: string; name: string }) => string;
  logDenied: (reason: string, context: Record<string, unknown>) => void;
  logSandboxLookupFailed: (context: Record<string, unknown>) => void;
}

/**
 * Compose the two halves into the `AgentTerminalCheckAuthFn` the realtime PTY
 * bridge consumes. The access half (gather inputs -> `decideAgentTerminalAccess`)
 * runs first and touches no Sprite; only once it allows AND a concurrency slot
 * is reserved does `resolveSandbox` resolve/read the Sprite for the fresh PTY.
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

    // Decrypt the actor email BEFORE reserving the slot (a decrypt throw here
    // must not leak a reserved slot — same ordering the fused checkAuth had).
    const tier = (userRow?.subscriptionTier ?? 'free') as SubscriptionTier;
    const actorEmail = await deps.resolveActorEmail(userRow?.email);

    // Read-only gates passed -> reserve the concurrency slot. Failing to reserve
    // IS the concurrency_limit denial (the pure decision's final gate, exercised
    // in its unit tests); nothing to release, since acquireSlot reserved nothing.
    if (!deps.acquireSlot({ userId, tier })) {
      deps.logDenied('concurrency_limit', { userId, machineId });
      return { ok: false, reason: 'concurrency_limit' };
    }
    const releaseSlot = () => deps.releaseSlot(userId);

    // Only NOW — a fresh PTY must be created — resolve/read the Sprite. If this
    // REJECTS (a DB error inside resolveAgentTerminal, a failed store/SDK
    // lookup) rather than returning a deny, the reserved slot must still be
    // released before the rejection propagates — otherwise a transient failure
    // permanently consumes the user's concurrency capacity. Re-throw so the
    // socket surface is unchanged (the PTY bridge's onConnect .catch emits the
    // generic error).
    let sandbox: ResolveTerminalSandboxResult;
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
      sessionKey: deps.buildSessionKey({ terminalId: machineId, projectName, branchName, name }),
      sprite: sandbox.sprite,
      releaseSlot,
      command: sandbox.command,
      args: sandbox.args,
      commandOverride: sandbox.commandOverride,
      streamSessionId: sandbox.streamSessionId,
      payerId: readOnly.payerId,
    };
  };
}
