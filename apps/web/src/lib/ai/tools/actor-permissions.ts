import type { ToolExecutionContext } from '../core';
import {
  getUserAccessLevel,
  getUserDriveAccess,
  canUserEditPage,
  canUserDeletePage,
  getUserAccessiblePagesInDriveWithDetails,
  type PageWithPermissions,
} from '@pagespace/lib/permissions/permissions';
import {
  getAgentAccessLevel,
  getAgentAccessiblePagesInDrive,
  hasAgentDriveMembership,
} from '@pagespace/lib/permissions/agent-permissions';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';

export function getAgentPageId(context: ToolExecutionContext): string | undefined {
  return context.chatSource?.type === 'page' ? context.chatSource.agentPageId : undefined;
}

/**
 * Whether the caller carries an MCP drive-scope restriction (a non-empty
 * allowedDriveIds). Empty/undefined means full access — session auth or an
 * unscoped token — and skips all scope checks.
 */
function hasMcpScope(context: ToolExecutionContext): boolean {
  return (context.mcpAllowedDriveIds?.length ?? 0) > 0;
}

/**
 * True when a scoped MCP caller is trying to reach a drive outside its token
 * scope. The actor's own ACL (user or agent) is checked separately; this is an
 * additional ceiling that a scoped token can never exceed, mirroring
 * checkMCPDriveScope on the REST surface.
 *
 * Exported so tools that authorize via primitives OTHER than the canActor*
 * chokepoint (e.g. activity, calendar, member listing) can apply the same
 * ceiling without changing their existing permission logic. Deny-only and a
 * no-op for unscoped callers, so it never affects the in-app product.
 */
export function driveOutsideMcpScope(context: ToolExecutionContext, driveId: string): boolean {
  if (!hasMcpScope(context)) return false;
  return !context.mcpAllowedDriveIds!.includes(driveId);
}

/**
 * Filter a list of drive IDs down to those a scoped MCP token may reach.
 * Returns the input unchanged for unscoped callers (full access).
 */
export function filterDriveIdsByMcpScope(
  context: ToolExecutionContext,
  driveIds: string[],
): string[] {
  if (!hasMcpScope(context)) return driveIds;
  const allowed = new Set(context.mcpAllowedDriveIds);
  return driveIds.filter((id) => allowed.has(id));
}

/**
 * Page-level equivalent: resolves the page's drive (only when a scope is active)
 * and fails closed if the drive cannot be determined.
 */
async function pageOutsideMcpScope(context: ToolExecutionContext, pageId: string): Promise<boolean> {
  if (!hasMcpScope(context)) return false;
  const [row] = await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, pageId));
  if (!row?.driveId) return true;
  return !context.mcpAllowedDriveIds!.includes(row.driveId);
}

export async function canActorEditPage(
  context: ToolExecutionContext,
  pageId: string,
): Promise<boolean> {
  if (await pageOutsideMcpScope(context, pageId)) return false;
  const agentPageId = getAgentPageId(context);
  if (agentPageId) {
    const perms = await getAgentAccessLevel(agentPageId, pageId);
    return perms?.canEdit ?? false;
  }
  return canUserEditPage(context.userId, pageId);
}

export async function canActorDeletePage(
  context: ToolExecutionContext,
  pageId: string,
): Promise<boolean> {
  if (await pageOutsideMcpScope(context, pageId)) return false;
  const agentPageId = getAgentPageId(context);
  if (agentPageId) {
    const perms = await getAgentAccessLevel(agentPageId, pageId);
    return perms?.canDelete ?? false;
  }
  return canUserDeletePage(context.userId, pageId);
}

export async function canActorViewPage(
  context: ToolExecutionContext,
  pageId: string,
): Promise<boolean> {
  if (await pageOutsideMcpScope(context, pageId)) return false;
  const agentPageId = getAgentPageId(context);
  if (agentPageId) {
    const perms = await getAgentAccessLevel(agentPageId, pageId);
    return perms?.canView ?? false;
  }
  const perms = await getUserAccessLevel(context.userId, pageId);
  return perms?.canView ?? false;
}

export async function canActorAccessDrive(
  context: ToolExecutionContext,
  driveId: string,
): Promise<boolean> {
  if (driveOutsideMcpScope(context, driveId)) return false;
  const agentPageId = getAgentPageId(context);
  if (agentPageId) return hasAgentDriveMembership(agentPageId, driveId);
  return getUserDriveAccess(context.userId, driveId);
}

/**
 * Whether the actor may manage drive-level resources that require elevated
 * authority — currently standalone cron workflows. Mirrors the workflows REST
 * API (apps/web/src/app/api/workflows/route.ts), which gates on owner/admin.
 *
 * User actors must be the drive owner or an admin (not merely a member or a
 * page-permission grantee). Agent actors are gated by their drive membership —
 * the same authority model used by every other agent write tool — since which
 * agents may schedule workflows is controlled by the agent's enabledTools
 * allowlist, configured by an owner/admin.
 */
export async function canActorManageDrive(
  context: ToolExecutionContext,
  driveId: string,
): Promise<boolean> {
  if (driveOutsideMcpScope(context, driveId)) return false;
  const agentPageId = getAgentPageId(context);
  if (agentPageId) return hasAgentDriveMembership(agentPageId, driveId);
  const access = await checkDriveAccess(driveId, context.userId);
  return access.isOwner || access.isAdmin;
}

export async function getActorAccessiblePagesInDrive(
  context: ToolExecutionContext,
  driveId: string,
): Promise<PageWithPermissions[]> {
  if (driveOutsideMcpScope(context, driveId)) return [];
  const agentPageId = getAgentPageId(context);
  if (agentPageId) {
    return getAgentAccessiblePagesInDrive(agentPageId, driveId);
  }
  return getUserAccessiblePagesInDriveWithDetails(context.userId, driveId);
}
