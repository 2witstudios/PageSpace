/**
 * Page Tree Context Module
 *
 * Builds a system prompt section that shows the workspace structure
 * to help AI agents understand navigation and organization.
 */

import { db } from '@pagespace/db/db'
import { eq, and, asc } from '@pagespace/db/operators'
import { pages, drives } from '@pagespace/db/schema/core';
import { getUserDriveAccess, getUserAccessiblePagesInDriveWithDetails } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { buildTree, formatTreeAsMarkdown, filterToSubtree, filterTreeNodesByAccess } from '@pagespace/lib/content/tree-utils';

interface TreeNode {
  id: string;
  title: string;
  type: string;
  parentId: string | null;
  position?: number;
}

async function queryDriveTree(driveId: string): Promise<TreeNode[]> {
  const result = await db
    .select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      parentId: pages.parentId,
      position: pages.position,
    })
    .from(pages)
    .where(and(
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false)
    ))
    .orderBy(asc(pages.position));

  return result.map(row => ({
    id: row.id,
    title: row.title ?? '',
    type: row.type,
    parentId: row.parentId,
    position: row.position ?? undefined,
  }));
}

interface PageTreeOptions {
  scope: 'children' | 'drive';
  pageId?: string;  // Required when scope is 'children'
  driveId: string;
  maxNodes?: number;
}

/**
 * Builds the page tree context for an AI agent's system prompt.
 *
 * @param userId - The authenticated user's ID
 * @param options - Tree scope and drive/page context
 * @returns A formatted markdown tree string, or empty string if access denied
 */
export async function getPageTreeContext(
  userId: string,
  options: PageTreeOptions
): Promise<string> {
  const { scope, pageId, driveId, maxNodes = 200 } = options;

  try {
    // Check user has access to drive
    const hasAccess = await getUserDriveAccess(userId, driveId);
    if (!hasAccess) {
      loggers.ai.debug('User lacks drive access for page tree', { userId, driveId });
      return '';
    }

    let nodes: TreeNode[] = await queryDriveTree(driveId);
    loggers.ai.debug('Page tree queried from DB', { driveId, nodeCount: nodes.length });

    if (scope === 'children' && pageId) {
      nodes = filterToSubtree(nodes, pageId);
      loggers.ai.debug('Filtered to subtree', { pageId, nodeCount: nodes.length });
    }

    // Drive access alone does NOT authorize seeing every page's title/type/id:
    // restrict the tree to the user's per-page accessible set so private-page
    // structure never leaks into the system prompt. We use the SAME source the
    // AI search tools use (getActorAccessiblePagesInDrive → this fn) and that
    // the page-view entry gate (getUserAccessLevel) honors — including custom
    // drive-role grants on private pages and custom-role denials of otherwise-
    // public pages — so the tree exactly matches what the user can actually see.
    // Ancestor-gated: an inaccessible page hides its whole subtree.
    const accessiblePages = await getUserAccessiblePagesInDriveWithDetails(userId, driveId);
    const accessibleIds = new Set(accessiblePages.map(p => p.id));
    const beforeFilter = nodes.length;
    nodes = filterTreeNodesByAccess(nodes, accessibleIds);
    loggers.ai.debug('Filtered page tree by per-page access', {
      driveId,
      userId,
      beforeFilter,
      afterFilter: nodes.length,
    });

    if (nodes.length === 0) {
      return '';
    }

    // Build tree structure from flat nodes
    const tree = buildTree(nodes);

    // Format as markdown with depth-based truncation
    const formatted = formatTreeAsMarkdown(tree, { maxNodes, showIcons: true });

    return formatted;

  } catch (error) {
    loggers.ai.error('Failed to build page tree context:', error as Error);
    return '';
  }
}

/**
 * Builds a summary of accessible drives for dashboard context
 * (when no specific drive is selected).
 *
 * @param userId - The authenticated user's ID
 * @returns A formatted list of accessible drives
 */
export async function getDriveListSummary(userId: string): Promise<string> {
  try {
    // Get all non-trashed drives
    const allDrives = await db
      .select({ id: drives.id, name: drives.name })
      .from(drives)
      .where(eq(drives.isTrashed, false));

    // Filter to drives the user has access to (parallel permission checks)
    const accessChecks = await Promise.all(
      allDrives.map(async (drive) => ({
        id: drive.id,
        name: drive.name,
        hasAccess: await getUserDriveAccess(userId, drive.id)
      }))
    );
    const accessibleDrives = accessChecks.filter(d => d.hasAccess);

    if (accessibleDrives.length === 0) {
      return 'No accessible workspaces.';
    }

    return `Available workspaces:\n${accessibleDrives.map(d => `- ${d.name} (id: ${d.id})`).join('\n')}`;

  } catch (error) {
    loggers.ai.error('Failed to build drive list summary:', error as Error);
    return '';
  }
}
