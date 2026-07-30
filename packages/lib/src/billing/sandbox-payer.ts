/**
 * resolveSandboxPayerId — the ONE seam that names who pays for a sandbox's
 * active runtime (and, via the idle-storage cron, its persistent storage).
 *
 * Every sandbox acquisition path (agent tool runs via
 * `createResolveSandboxActorContext`, interactive PTY sessions via
 * `makeTerminalCheckAuth`) resolves `tenantId` to the ACTING drive's
 * `ownerId` — correct when the sandbox is anchored to the agent's own page in
 * its own drive, but an agent page can be shared into a DIFFERENT drive than
 * the acting tenant's (page-permission-based, not per-drive). In that case
 * `tenantId` is the ACTOR's drive owner, not the referenced page's — so this
 * resolves the referenced page's own drive owner and bills THAT account,
 * falling back to `tenantId` only when there's no backing page (e.g. a
 * global-assistant run with no agent page) or the page's owner can't be
 * resolved (orphaned page).
 *
 * `lookupPageOwnerId` is injected (not a direct DB import) so this stays a
 * pure, independently-testable seam; `lookupPageOwnerId` below is the one real
 * implementation every caller wires in, so the pages→drives join is written
 * exactly once.
 */
export interface ResolveSandboxPayerInput {
  /** Fallback payer — the ACTING drive's owner, as resolved by every current sandbox-acquisition path. */
  tenantId: string;
  /** The active sandbox's backing agent page id; undefined when there's no backing page. */
  agentPageId?: string;
  /** Resolves a page's owning drive's `ownerId`; null when the page/drive can't be found. */
  lookupPageOwnerId: (pageId: string) => Promise<string | null>;
}

export async function resolveSandboxPayerId(input: ResolveSandboxPayerInput): Promise<string> {
  if (!input.agentPageId) return input.tenantId;
  const ownerId = await input.lookupPageOwnerId(input.agentPageId);
  return ownerId ?? input.tenantId;
}

/**
 * resolveAgentSessionPayerId — the agent-sessions twin of `resolveSandboxPayerId`
 * above, and the ONLY place the nullable-`agentPageId` payer invariant is
 * handled (Phase 7, billing/storage re-point). Do not re-derive this fallback
 * elsewhere.
 *
 * An `agent_sessions` row's `agentPageId` is nullable — null means a
 * global-assistant session with no backing page at all, not an orphaned
 * reference. So the fallback here is the row's own `ownerId` (always present),
 * never a caller-supplied tenantId: unlike a sandbox acquisition (which can be
 * addressed from a different drive than the acting tenant), a session's owner
 * IS its payer of last resort by construction.
 *
 * When `agentPageId` IS set, resolution is identical to
 * `resolveSandboxPayerId`: look up the page's owning drive's owner, falling
 * back to `ownerId` if that lookup fails (e.g. an orphaned page) rather than
 * leaving the session unbillable.
 */
export interface ResolveAgentSessionPayerInput {
  /** The session's own owner — the fallback payer, and the ONLY payer for a null-`agentPageId` (global-assistant) session. */
  ownerId: string;
  /** The session's backing agent page; null for a global-assistant session. */
  agentPageId: string | null;
  /** Resolves a page's owning drive's `ownerId`; null when the page/drive can't be found. */
  lookupPageOwnerId: (pageId: string) => Promise<string | null>;
}

export async function resolveAgentSessionPayerId(input: ResolveAgentSessionPayerInput): Promise<string> {
  if (!input.agentPageId) return input.ownerId;
  const ownerId = await input.lookupPageOwnerId(input.agentPageId);
  return ownerId ?? input.ownerId;
}

/**
 * Real DB-backed page→drive-owner lookup — the ONE place this join is
 * written. `leftJoin` (not `innerJoin`) so a page whose drive vanished (should
 * never happen given the cascade FK, but defends against a stale read) resolves
 * to `null` rather than silently dropping the row.
 */
export async function lookupPageOwnerId(pageId: string): Promise<string | null> {
  const { db } = await import('@pagespace/db/db');
  const { eq } = await import('@pagespace/db/operators');
  const { pages, drives } = await import('@pagespace/db/schema/core');

  const [row] = await db
    .select({ ownerId: drives.ownerId })
    .from(pages)
    .leftJoin(drives, eq(pages.driveId, drives.id))
    .where(eq(pages.id, pageId))
    .limit(1);

  return row?.ownerId ?? null;
}

/**
 * Real DB-backed drive→owner lookup — the ONE place this read is written for
 * billing. A session is a drive-level workspace, so its storage bills the
 * drive's owner; null when the drive cannot be found (a stale read mid-delete
 * — the storage reconcile skips rather than misattributing).
 */
export async function lookupDriveOwnerId(driveId: string): Promise<string | null> {
  const { db } = await import('@pagespace/db/db');
  const { eq } = await import('@pagespace/db/operators');
  const { drives } = await import('@pagespace/db/schema/core');

  const [row] = await db
    .select({ ownerId: drives.ownerId })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  return row?.ownerId ?? null;
}
