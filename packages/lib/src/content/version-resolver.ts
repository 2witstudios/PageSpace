/**
 * Version Resolver
 *
 * Resolves content pairs for diffing from page versions.
 * This is the core primitive for version traversal - can be used by:
 * - get_activity (diff recent changes)
 * - compare_versions (diff any two revisions) [future]
 * - search_history (find changes matching criteria) [future]
 *
 * Key insight: Activity logs store pre-update content (for rollback),
 * while page versions store post-update content. This module bridges
 * the two to provide accurate before/after pairs for diffing.
 */

import { db, pageVersions, eq, and, or, desc } from '@pagespace/db';

/**
 * Content pair for generating diffs
 */
export interface VersionContentPair {
  /** Page ID */
  pageId: string;
  /** Content before the changes (from activity snapshot or prior version) */
  beforeContentRef: string | null;
  /** Content after the changes (from page version) */
  afterContentRef: string | null;
  /** Revision number before changes */
  beforeRevision: number;
  /** Revision number after changes */
  afterRevision: number;
  /** Change group ID linking activity to version */
  changeGroupId: string;
}

/**
 * Request for resolving version content
 */
export interface VersionResolveRequest {
  /** Page ID */
  pageId: string;
  /** Change group ID from activity log */
  changeGroupId: string;
  /** Content ref from activity log (pre-update content) */
  activityContentRef?: string | null;
}

/**
 * Page version record from database
 */
interface PageVersionRecord {
  id: string;
  pageId: string;
  contentRef: string | null;
  pageRevision: number;
  changeGroupId: string | null;
}

/**
 * Resolves content pairs for a single page/changeGroup combination.
 *
 * For accurate diffing:
 * - beforeContentRef: From activity log (pre-update snapshot)
 * - afterContentRef: From page version (post-update state)
 *
 * @param request - Page ID, change group ID, and optional activity content ref
 * @returns Content pair or null if version not found
 */
export async function resolveVersionContent(
  request: VersionResolveRequest
): Promise<VersionContentPair | null> {
  const { pageId, changeGroupId, activityContentRef } = request;

  // Find page version with matching changeGroupId
  const [version] = await db
    .select({
      id: pageVersions.id,
      pageId: pageVersions.pageId,
      contentRef: pageVersions.contentRef,
      pageRevision: pageVersions.pageRevision,
      changeGroupId: pageVersions.changeGroupId,
    })
    .from(pageVersions)
    .where(
      and(
        eq(pageVersions.pageId, pageId),
        eq(pageVersions.changeGroupId, changeGroupId)
      )
    )
    .orderBy(desc(pageVersions.pageRevision))
    .limit(1);

  if (!version) {
    return null;
  }

  return {
    pageId,
    beforeContentRef: activityContentRef ?? null,
    afterContentRef: version.contentRef,
    beforeRevision: version.pageRevision > 0 ? version.pageRevision - 1 : 0,
    afterRevision: version.pageRevision,
    changeGroupId,
  };
}

/**
 * Batch resolve content pairs for multiple pages/changeGroups.
 * Single query for efficiency - eliminates N+1 queries.
 *
 * @param requests - Array of page ID, change group ID, and optional activity content ref
 * @returns Map of "pageId:changeGroupId" -> VersionContentPair (composite key for security)
 */
export async function batchResolveVersionContent(
  requests: VersionResolveRequest[]
): Promise<Map<string, VersionContentPair>> {
  const results = new Map<string, VersionContentPair>();

  if (requests.length === 0) {
    return results;
  }

  // Build OR conditions for each (pageId, changeGroupId) pair - ensures proper scoping
  const conditions = requests.map((r) =>
    and(eq(pageVersions.pageId, r.pageId), eq(pageVersions.changeGroupId, r.changeGroupId))
  );

  // Batch query for all versions with matching (pageId, changeGroupId) pairs
  const versions = await db
    .select({
      id: pageVersions.id,
      pageId: pageVersions.pageId,
      contentRef: pageVersions.contentRef,
      pageRevision: pageVersions.pageRevision,
      changeGroupId: pageVersions.changeGroupId,
    })
    .from(pageVersions)
    .where(or(...conditions))
    .orderBy(desc(pageVersions.pageRevision));

  // Build lookup map: "pageId:changeGroupId" -> version (composite key prevents cross-page leaks)
  const versionMap = new Map<string, PageVersionRecord>();
  for (const version of versions) {
    if (version.changeGroupId) {
      const compositeKey = `${version.pageId}:${version.changeGroupId}`;
      if (!versionMap.has(compositeKey)) {
        // Keep first (highest revision) for each (pageId, changeGroupId) pair
        versionMap.set(compositeKey, version);
      }
    }
  }

  // Build activity content ref lookup using composite key
  const activityContentRefMap = new Map<string, string | null>();
  for (const request of requests) {
    const compositeKey = `${request.pageId}:${request.changeGroupId}`;
    activityContentRefMap.set(compositeKey, request.activityContentRef ?? null);
  }

  // Build results using composite key
  for (const request of requests) {
    const compositeKey = `${request.pageId}:${request.changeGroupId}`;
    const version = versionMap.get(compositeKey);
    if (!version) {
      continue;
    }

    const activityContentRef = activityContentRefMap.get(compositeKey);

    results.set(compositeKey, {
      pageId: request.pageId,
      beforeContentRef: activityContentRef ?? null,
      afterContentRef: version.contentRef,
      beforeRevision: version.pageRevision > 0 ? version.pageRevision - 1 : 0,
      afterRevision: version.pageRevision,
      changeGroupId: request.changeGroupId,
    });
  }

  return results;
}

/**
 * Resolve content pairs for grouped activities.
 *
 * When activities are stacked (multiple saves in a changeGroup),
 * we want:
 * - beforeContentRef: From the FIRST activity (oldest pre-update state)
 * - afterContentRef: From the page version (final post-update state)
 *
 * This gives a diff showing the complete change from start to finish
 * of an editing session or AI generation.
 *
 * @param groupedActivities - Activities grouped by changeGroupId, with first/last content refs
 * @returns Map of changeGroupId -> VersionContentPair
 */
export async function resolveStackedVersionContent(
  groupedActivities: Array<{
    changeGroupId: string;
    pageId: string;
    firstContentRef: string | null;
  }>
): Promise<Map<string, VersionContentPair>> {
  if (groupedActivities.length === 0) {
    return new Map();
  }

  const requests: VersionResolveRequest[] = groupedActivities.map((group) => ({
    pageId: group.pageId,
    changeGroupId: group.changeGroupId,
    activityContentRef: group.firstContentRef,
  }));

  return batchResolveVersionContent(requests);
}
