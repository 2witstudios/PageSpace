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

export function getAgentPageId(context: ToolExecutionContext): string | undefined {
  return context.chatSource?.type === 'page' ? context.chatSource.agentPageId : undefined;
}

export async function canActorEditPage(
  context: ToolExecutionContext,
  pageId: string,
): Promise<boolean> {
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
  const agentPageId = getAgentPageId(context);
  if (agentPageId) return hasAgentDriveMembership(agentPageId, driveId);
  const access = await checkDriveAccess(driveId, context.userId);
  return access.isOwner || access.isAdmin;
}

export async function getActorAccessiblePagesInDrive(
  context: ToolExecutionContext,
  driveId: string,
): Promise<PageWithPermissions[]> {
  const agentPageId = getAgentPageId(context);
  if (agentPageId) {
    return getAgentAccessiblePagesInDrive(agentPageId, driveId);
  }
  return getUserAccessiblePagesInDriveWithDetails(context.userId, driveId);
}
