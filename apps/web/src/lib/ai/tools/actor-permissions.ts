import type { ToolExecutionContext } from '../core';
import {
  getUserAccessLevel,
  canUserEditPage,
  canUserDeletePage,
  getUserAccessiblePagesInDriveWithDetails,
  type PageWithPermissions,
} from '@pagespace/lib/permissions/permissions';
import {
  getAgentAccessLevel,
  getAgentAccessiblePagesInDrive,
} from '@pagespace/lib/permissions/agent-permissions';

export function getAgentPageId(context: ToolExecutionContext): string | undefined {
  return context.chatSource?.type === 'page' ? context.chatSource.agentPageId : undefined;
}

/**
 * Check whether the actor (user or page-agent) can edit a page.
 *
 * If the context comes from a page-agent that has a drive_agent_members row,
 * the agent's own role governs the decision. Otherwise falls back to the
 * calling user's permissions.
 */
export async function canActorEditPage(
  context: ToolExecutionContext,
  pageId: string,
): Promise<boolean> {
  const agentPageId = getAgentPageId(context);
  if (agentPageId) {
    const agentPerms = await getAgentAccessLevel(agentPageId, pageId);
    if (agentPerms !== null) return agentPerms.canEdit;
  }
  return canUserEditPage(context.userId, pageId);
}

/**
 * Check whether the actor can delete a page.
 */
export async function canActorDeletePage(
  context: ToolExecutionContext,
  pageId: string,
): Promise<boolean> {
  const agentPageId = getAgentPageId(context);
  if (agentPageId) {
    const agentPerms = await getAgentAccessLevel(agentPageId, pageId);
    if (agentPerms !== null) return agentPerms.canDelete;
  }
  return canUserDeletePage(context.userId, pageId);
}

/**
 * Check whether the actor can view a page.
 */
export async function canActorViewPage(
  context: ToolExecutionContext,
  pageId: string,
): Promise<boolean> {
  const agentPageId = getAgentPageId(context);
  if (agentPageId) {
    const agentPerms = await getAgentAccessLevel(agentPageId, pageId);
    if (agentPerms !== null) return agentPerms.canView;
  }
  const perms = await getUserAccessLevel(context.userId, pageId);
  return perms?.canView ?? false;
}

/**
 * Get all pages the actor can access in a drive.
 *
 * For page-agents with a drive_agent_members row, returns their scoped list.
 * Falls back to the calling user's accessible pages when no membership exists.
 */
export async function getActorAccessiblePagesInDrive(
  context: ToolExecutionContext,
  driveId: string,
): Promise<PageWithPermissions[]> {
  const agentPageId = getAgentPageId(context);
  if (agentPageId) {
    const agentPages = await getAgentAccessiblePagesInDrive(agentPageId, driveId);
    if (agentPages !== null) return agentPages; // null = no membership; non-null = scoped result
  }
  return getUserAccessiblePagesInDriveWithDetails(context.userId, driveId);
}
