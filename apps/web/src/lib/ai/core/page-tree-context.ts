/**
 * Page Tree Context Module
 *
 * Builds a system prompt section that shows the workspace structure
 * to help AI agents understand navigation and organization.
 *
 * Uses per-drive caching to reduce database queries. Cache is invalidated
 * when pages are created, moved, deleted, or reordered.
 */

import { db, pages, drives, eq, and, asc } from '@pagespace/db';
import { getUserDriveAccess, pageTreeCache, loggers } from '@pagespace/lib/server';
import { buildTree, formatTreeAsMarkdown, filterToSubtree } from '@pagespace/lib';
import type { CachedTreeNode } from '@pagespace/lib/server';

/**
 * Query page tree for a drive from the database
 * Returns flat list of page nodes (structure is built later)
 */
async function queryDriveTree(driveId: string): Promise<CachedTreeNode[]> {
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

  return result;
}

/**
 * Get the name of a drive
 */
async function getDriveName(driveId: string): Promise<string | null> {
  const [drive] = await db
    .select({ name: drives.name })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  return drive?.name || null;
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

    // Try cache first
    let nodes: CachedTreeNode[];
    const cached = await pageTreeCache.getDriveTree(driveId);

    if (cached) {
      nodes = cached.nodes;
      loggers.ai.debug('Page tree cache hit', { driveId, nodeCount: nodes.length });
    } else {
      // Cache miss - query DB
      nodes = await queryDriveTree(driveId);
      const driveName = await getDriveName(driveId);

      if (driveName) {
        await pageTreeCache.setDriveTree(driveId, driveName, nodes);
      }
      loggers.ai.debug('Page tree cache miss, queried DB', { driveId, nodeCount: nodes.length });
    }

    // Filter to subtree if scope is 'children'
    if (scope === 'children' && pageId) {
      nodes = filterToSubtree(nodes, pageId);
      loggers.ai.debug('Filtered to subtree', { pageId, nodeCount: nodes.length });
    }

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
