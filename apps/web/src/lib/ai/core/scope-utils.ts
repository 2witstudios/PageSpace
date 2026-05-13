import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { filterToSubtree } from '@pagespace/lib/content/tree-utils';
import type { ToolExecutionContext } from './types';

export type PageAccessScope = ToolExecutionContext['pageAccessScope'];

async function getAllowedIds(driveId: string, agentPageId: string): Promise<Set<string>> {
  const allDrivePages = await db
    .select({ id: pages.id, parentId: pages.parentId })
    .from(pages)
    .where(and(eq(pages.driveId, driveId), eq(pages.isTrashed, false)));
  return new Set(filterToSubtree(allDrivePages, agentPageId).map((p: { id: string }) => p.id));
}

/** Throws if pageId is outside the agent's allowed subtree. No-op when scope is 'drive'. */
export async function assertPageInScope(
  pageId: string,
  driveId: string,
  scope: PageAccessScope,
): Promise<void> {
  if (scope?.type !== 'subtree') return;
  const allowed = await getAllowedIds(driveId, scope.agentPageId);
  if (!allowed.has(pageId)) {
    throw new Error("This page is outside the agent's configured access scope");
  }
}

/** Throws if parentId (or null = drive root) is outside the allowed subtree. */
export async function assertParentInScope(
  parentId: string | null | undefined,
  driveId: string,
  scope: PageAccessScope,
): Promise<void> {
  if (scope?.type !== 'subtree') return;
  if (!parentId) {
    throw new Error("Creating pages at the drive root is outside the agent's configured access scope");
  }
  const allowed = await getAllowedIds(driveId, scope.agentPageId);
  if (!allowed.has(parentId)) {
    throw new Error("The destination parent is outside the agent's configured access scope");
  }
}
