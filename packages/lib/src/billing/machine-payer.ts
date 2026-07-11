/**
 * resolveMachinePayerId — the ONE seam that names who pays for a Machine's
 * active runtime (and, via the idle-storage cron, its persistent storage).
 *
 * Every sandbox acquisition path (agent tool runs via
 * `createResolveSandboxActorContext`, interactive PTY sessions via
 * `makeTerminalCheckAuth`) resolves `tenantId` to the ACTING drive's
 * `ownerId` — correct for an 'own' machine (the agent's own page, in its own
 * drive), but a `MachineRef` of `{ kind: 'existing', machineId }` can address
 * a Machine page in a DIFFERENT drive (Machine scope is page-permission-based,
 * not per-drive — tasks/terminal.md). In that case `tenantId` is the ACTOR's
 * drive owner, not the referenced machine's — so this resolves the referenced
 * page's own drive owner and bills THAT account, falling back to `tenantId`
 * only when there's no backing page (e.g. no active machine yet) or the page's
 * owner can't be resolved (orphaned page).
 *
 * `lookupPageOwnerId` is injected (not a direct DB import) so this stays a
 * pure, independently-testable seam; `lookupPageOwnerId` below is the one real
 * implementation every caller wires in, so the pages→drives join is written
 * exactly once.
 */
export interface ResolveMachinePayerInput {
  /** Fallback payer — the ACTING drive's owner, as resolved by every current machine-acquisition path. */
  tenantId: string;
  /** The ACTIVE machine's backing page id (see `resolveMachinePageId` in machine-session.ts); undefined when there's no backing page. */
  machinePageId?: string;
  /** Resolves a page's owning drive's `ownerId`; null when the page/drive can't be found. */
  lookupPageOwnerId: (pageId: string) => Promise<string | null>;
}

export async function resolveMachinePayerId(input: ResolveMachinePayerInput): Promise<string> {
  if (!input.machinePageId) return input.tenantId;
  const ownerId = await input.lookupPageOwnerId(input.machinePageId);
  return ownerId ?? input.tenantId;
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
