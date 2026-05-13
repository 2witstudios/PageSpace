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
