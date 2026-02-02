import { tool } from 'ai';
import { z } from 'zod';
import {
  db,
  activityLogs,
  drives,
  driveMembers,
  sessions,
  eq,
  and,
  or,
  desc,
  gte,
  ne,
  isNull,
  inArray,
} from '@pagespace/db';
import { isUserDriveMember, getBatchPagePermissions, isDriveOwnerOrAdmin } from '@pagespace/lib';
import {
  groupActivitiesForDiff,
  resolveStackedVersionContent,
  generateDiffsWithinBudget,
  calculateDiffBudget,
  type ActivityForDiff,
  type DiffRequest,
} from '@pagespace/lib/content';
import { readPageContent } from '@pagespace/lib/server';
import { type ToolExecutionContext } from '../core';

/**
 * Activity tools for AI agents
 *
 * Provides insight into recent workspace activity, enabling:
 * - Context-aware assistance (what has the user been working on?)
 * - Collaboration awareness (what have others changed?)
 * - Pulse/welcome messages (what happened since last visit?)
 */

// Operation categories for filtering
const CONTENT_OPERATIONS = ['create', 'update', 'delete', 'restore', 'move', 'trash', 'reorder'] as const;
const PERMISSION_OPERATIONS = ['permission_grant', 'permission_update', 'permission_revoke'] as const;
const MEMBERSHIP_OPERATIONS = ['member_add', 'member_remove', 'member_role_change', 'ownership_transfer'] as const;

// Time window helpers
function getTimeWindowStart(window: string, lastVisitTime?: Date): Date {
  const now = new Date();

  switch (window) {
    case '1h':
      return new Date(now.getTime() - 60 * 60 * 1000);
    case '24h':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case 'last_visit':
      // Fall back to 7 days if no last visit time
      return lastVisitTime || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    default:
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
}

// Get user's last active session time
async function getLastVisitTime(userId: string): Promise<Date | undefined> {
  // Get the user's previous session (not the current one)
  const previousSessions = await db
    .select({ lastUsedAt: sessions.lastUsedAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.type, 'user'),
        isNull(sessions.revokedAt)
      )
    )
    .orderBy(desc(sessions.lastUsedAt))
    .limit(2);

  // If we have at least 2 sessions, return the second one's lastUsedAt
  // (the first one is the current session)
  if (previousSessions.length >= 2 && previousSessions[1]?.lastUsedAt) {
    return previousSessions[1].lastUsedAt;
  }

  // Fallback: look for the user's last login activity
  const [lastLogin] = await db
    .select({ timestamp: activityLogs.timestamp })
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.userId, userId),
        eq(activityLogs.operation, 'login')
      )
    )
    .orderBy(desc(activityLogs.timestamp))
    .limit(1);

  return lastLogin?.timestamp;
}

// Compact activity format optimized for AI context efficiency
interface CompactActivity {
  ts: string;              // ISO timestamp
  op: string;              // operation
  res: string;             // resourceType
  title: string | null;    // resourceTitle
  pageId: string | null;
  actor: number;           // index into actors array
  ai?: string;             // AI model if ai-generated (e.g., "gpt-4o")
  fields?: string[];       // which fields changed
  delta?: Record<string, { from?: unknown; to?: unknown; len?: { from: number; to: number } }>;
}

interface ContentDiffSummary {
  pageId: string;
  pageTitle: string | null;
  collapsedCount: number;
  timeRange: { from: string; to: string };
  actors: string[];
  unifiedDiff: string;
  stats: { additions: number; deletions: number };
  isAiGenerated: boolean;
}

interface CompactDriveGroup {
  drive: {
    id: string;
    name: string;
    slug: string;
    context: string | null;  // drivePrompt - gives AI context about the workspace purpose
  };
  activities: CompactActivity[];
  stats: {
    total: number;
    byOp: Record<string, number>;
    aiCount: number;
  };
  contentDiffs?: ContentDiffSummary[];  // Optional: actual content diffs when includeContentDiffs=true
}

interface CompactActor {
  email: string;
  name: string | null;
  isYou: boolean;  // is this the current user
  count: number;   // activity count
}

// Helper to create compact delta from previousValues/newValues
function createCompactDelta(
  updatedFields: string[] | null,
  prev: Record<string, unknown> | null,
  next: Record<string, unknown> | null
): Record<string, { from?: unknown; to?: unknown; len?: { from: number; to: number } }> | undefined {
  if (!updatedFields || updatedFields.length === 0) return undefined;

  const delta: Record<string, { from?: unknown; to?: unknown; len?: { from: number; to: number } }> = {};

  for (const field of updatedFields) {
    const fromVal = prev?.[field];
    const toVal = next?.[field];

    // For content/text fields, just show length change to save tokens
    if (field === 'content' || field === 'systemPrompt' || field === 'drivePrompt') {
      const fromLen = typeof fromVal === 'string' ? fromVal.length : 0;
      const toLen = typeof toVal === 'string' ? toVal.length : 0;
      if (fromLen !== toLen) {
        delta[field] = { len: { from: fromLen, to: toLen } };
      }
    } else if (field === 'title') {
      // Title changes are small and meaningful - include full values
      delta[field] = { from: fromVal, to: toVal };
    } else if (typeof fromVal === 'boolean' || typeof toVal === 'boolean') {
      // Booleans are small
      delta[field] = { from: fromVal, to: toVal };
    } else if (typeof fromVal === 'number' || typeof toVal === 'number') {
      // Numbers are small
      delta[field] = { from: fromVal, to: toVal };
    } else {
      // For other fields, just note they changed
      delta[field] = {};
    }
  }

  return Object.keys(delta).length > 0 ? delta : undefined;
}

export const activityTools = {
  /**
   * Get recent activity across workspaces
   *
   * Use this to understand what has been happening in the workspace:
   * - What the user has been working on
   * - What others have changed (for collaboration awareness)
   * - Changes since last visit (for pulse/welcome messages)
   *
   * Returns activities grouped by drive with rich context including:
   * - Drive metadata (name, description/prompt for context)
   * - Detailed change information (what fields changed, before/after values)
   * - AI attribution (which changes were AI-generated)
   * - Contributor summary
   */
  get_activity: tool({
    description: `Get recent activity in the user's workspaces to understand what has changed.

Use this tool to:
- Understand what the user has been working on recently
- See what collaborators have changed in shared workspaces
- Generate informed welcome/pulse messages about changes since last visit
- Get context before making suggestions or edits

Returns activities grouped by drive with:
- Drive context (name, AI prompt/description)
- Detailed change diffs (what changed, previous vs new values)
- AI attribution (which changes were AI-generated)
- Contributor breakdown

CRITICAL - How to present activity summaries to users:
- NEVER report raw numbers or metrics like "5 pages updated" or "23 lines changed"
- ALWAYS describe what actually happened in plain language the user cares about
- Focus on the MEANING and IMPACT of changes, not counts or technical details
- Use the delta/diff data to explain WHAT changed, not just THAT something changed

Good examples:
- "Sarah updated the project timeline - the deadline moved from Feb 15 to March 1"
- "The API documentation now includes authentication examples for OAuth2"
- "Alex reorganized the Design folder, moving mockups into a new 'v2' subfolder"
- "The homepage hero section was rewritten with a new value proposition"

Bad examples (never do this):
- "There were 5 updates to 3 pages"
- "15 lines were changed in the documentation"
- "Activity detected: 2 creates, 3 updates"
- "John made changes to Project Plan"

When summarizing multiple changes, group them thematically and describe the overall narrative of what happened, not an inventory of operations.`,

    inputSchema: z.object({
      since: z
        .enum(['1h', '24h', '7d', '30d', 'last_visit'])
        .default('24h')
        .describe(
          'Time window for activity. Use "last_visit" for pulse messages to show changes since user was last active'
        ),

      driveIds: z
        .array(z.string())
        .optional()
        .describe(
          'Specific drive IDs to fetch activity for. If not provided, fetches from all accessible drives'
        ),

      excludeOwnActivity: z
        .boolean()
        .default(false)
        .describe(
          'Set to true to only see what OTHER people (or AI) have changed. Useful for collaboration awareness and pulse messages'
        ),

      includeAiChanges: z
        .boolean()
        .default(true)
        .describe('Whether to include AI-generated changes in results'),

      operationCategories: z
        .array(z.enum(['content', 'permissions', 'membership']))
        .optional()
        .describe(
          'Filter by operation category. content = create/update/delete/move, permissions = permission changes, membership = member add/remove/role changes'
        ),

      limit: z
        .number()
        .min(1)
        .max(100)
        .default(50)
        .describe('Maximum activities to fetch (hard cap 100)'),

      maxOutputChars: z
        .number()
        .min(1000)
        .max(50000)
        .default(20000)
        .describe('Hard limit on output size in chars (~4 chars/token). Default 20k chars ≈ 5k tokens'),

      includeDiffs: z
        .boolean()
        .default(true)
        .describe(
          'Include change diffs. Set false for lighter response'
        ),

      includeContentDiffs: z
        .boolean()
        .default(true)
        .describe(
          'Include semantic content diffs for pages with changes. Returns unified diffs showing actual content changes. Use for pulse notifications to see what collaborators actually wrote.'
        ),
    }),

    execute: async (
      {
        since,
        driveIds,
        excludeOwnActivity,
        includeAiChanges,
        operationCategories,
        limit,
        maxOutputChars,
        includeDiffs,
        includeContentDiffs,
      },
      { experimental_context: context }
    ) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get last visit time if needed
        let lastVisitTime: Date | undefined;
        if (since === 'last_visit') {
          lastVisitTime = await getLastVisitTime(userId);
        }

        const timeWindowStart = getTimeWindowStart(since, lastVisitTime);

        // Get all drives the user has access to
        let targetDriveIds: string[];

        if (driveIds && driveIds.length > 0) {
          // Verify access to specified drives
          const accessChecks = await Promise.all(
            driveIds.map(async (driveId) => ({
              driveId,
              hasAccess: await isUserDriveMember(userId, driveId),
            }))
          );

          const accessibleDrives = accessChecks.filter((c) => c.hasAccess);
          const deniedDrives = accessChecks.filter((c) => !c.hasAccess);

          if (accessibleDrives.length === 0) {
            throw new Error('No access to any of the specified drives');
          }

          targetDriveIds = accessibleDrives.map((c) => c.driveId);

          if (deniedDrives.length > 0) {
            console.warn('get_activity: access denied for some drives', {
              deniedDriveCount: deniedDrives.length,
              requestedDriveCount: driveIds.length,
            });
          }
        } else {
          // Single query to get all accessible drive IDs:
          // 1. Drives user is a member of (via driveMembers)
          // 2. Drives user owns (via drives.ownerId)
          const [memberDrives, ownedDrives] = await Promise.all([
            db
              .select({ driveId: driveMembers.driveId })
              .from(driveMembers)
              .innerJoin(drives, eq(driveMembers.driveId, drives.id))
              .where(
                and(
                  eq(driveMembers.userId, userId),
                  eq(drives.isTrashed, false)
                )
              ),
            db
              .select({ id: drives.id })
              .from(drives)
              .where(
                and(
                  eq(drives.ownerId, userId),
                  eq(drives.isTrashed, false)
                )
              ),
          ]);

          // Combine and deduplicate drive IDs
          const driveIdSet = new Set<string>();
          for (const d of memberDrives) driveIdSet.add(d.driveId);
          for (const d of ownedDrives) driveIdSet.add(d.id);
          targetDriveIds = Array.from(driveIdSet);
        }

        if (targetDriveIds.length === 0) {
          return {
            ok: true,
            actors: [],
            drives: [],
            meta: {
              total: 0,
              aiTotal: 0,
              window: since,
              from: timeWindowStart.toISOString(),
              lastVisit: lastVisitTime?.toISOString() || null,
              excludedSelf: excludeOwnActivity,
            },
          };
        }

        // Build operation filter
        const operationFilter: string[] = [];
        if (operationCategories && operationCategories.length > 0) {
          for (const category of operationCategories) {
            switch (category) {
              case 'content':
                operationFilter.push(...CONTENT_OPERATIONS);
                break;
              case 'permissions':
                operationFilter.push(...PERMISSION_OPERATIONS);
                break;
              case 'membership':
                operationFilter.push(...MEMBERSHIP_OPERATIONS);
                break;
            }
          }
        }

        // Build query conditions
        const conditions = [
          inArray(activityLogs.driveId, targetDriveIds),
          gte(activityLogs.timestamp, timeWindowStart),
          eq(activityLogs.isArchived, false),
        ];

        if (excludeOwnActivity) {
          // Include activities from other users OR system/AI activities with NULL userId
          conditions.push(or(ne(activityLogs.userId, userId), isNull(activityLogs.userId))!);
        }

        if (!includeAiChanges) {
          conditions.push(eq(activityLogs.isAiGenerated, false));
        }

        if (operationFilter.length > 0) {
          // Cast to the column's enum type for type safety with inArray
          conditions.push(
            inArray(
              activityLogs.operation,
              operationFilter as (typeof activityLogs.operation._.data)[]
            )
          );
        }

        // Fetch activities
        const activities = await db.query.activityLogs.findMany({
          where: and(...conditions),
          with: {
            user: {
              columns: { id: true, name: true, email: true },
            },
            drive: {
              columns: { id: true, name: true, slug: true, drivePrompt: true },
            },
          },
          orderBy: [desc(activityLogs.timestamp)],
          limit,
        });

        // Build actor index for deduplication (saves tokens by not repeating actor info)
        // Store actor reference directly so count updates are shared
        const actorMap = new Map<string, { idx: number; actor: CompactActor }>();
        const actorsList: CompactActor[] = [];

        for (const activity of activities) {
          const email = activity.actorEmail;
          let entry = actorMap.get(email);
          if (!entry) {
            const actor: CompactActor = {
              email,
              name: activity.actorDisplayName || activity.user?.name || null,
              isYou: activity.userId === userId,
              count: 0,
            };
            entry = { idx: actorsList.length, actor };
            actorsList.push(actor);
            actorMap.set(email, entry);
          }
          entry.actor.count++;
        }

        // Group activities by drive using compact format
        const driveGroupsMap = new Map<string, CompactDriveGroup>();

        for (const activity of activities) {
          if (!activity.driveId || !activity.drive) continue;

          let group = driveGroupsMap.get(activity.driveId);
          if (!group) {
            group = {
              drive: {
                id: activity.drive.id,
                name: activity.drive.name,
                slug: activity.drive.slug,
                context: activity.drive.drivePrompt,
              },
              activities: [],
              stats: {
                total: 0,
                byOp: {},
                aiCount: 0,
              },
            };
            driveGroupsMap.set(activity.driveId, group);
          }

          // Build compact activity
          const actorIdx = actorMap.get(activity.actorEmail)!.idx;
          const compact: CompactActivity = {
            ts: activity.timestamp.toISOString(),
            op: activity.operation,
            res: activity.resourceType,
            title: activity.resourceTitle,
            pageId: activity.pageId,
            actor: actorIdx,
          };

          // Add AI model if ai-generated (compact: just the model name)
          if (activity.isAiGenerated && activity.aiModel) {
            compact.ai = activity.aiModel;
          }

          // Add compact delta if diffs requested
          if (includeDiffs && activity.updatedFields) {
            compact.fields = activity.updatedFields;
            const delta = createCompactDelta(
              activity.updatedFields,
              activity.previousValues,
              activity.newValues
            );
            if (delta) {
              compact.delta = delta;
            }
          }

          group.activities.push(compact);

          // Update stats
          group.stats.total++;
          group.stats.byOp[activity.operation] =
            (group.stats.byOp[activity.operation] || 0) + 1;
          if (activity.isAiGenerated) {
            group.stats.aiCount++;
          }
        }

        // Convert to array and sort by activity count
        const driveGroups = Array.from(driveGroupsMap.values()).sort(
          (a, b) => b.stats.total - a.stats.total
        );

        // Generate content diffs if requested
        if (includeContentDiffs) {
          // P2 Budget: Use maxOutputChars parameter to calculate proportional budget
          const diffBudget = calculateDiffBudget(maxOutputChars);

          // Collect all activities with page content changes
          let pageActivities = activities.filter(
            (a) =>
              a.pageId &&
              a.resourceType === 'page' &&
              (a.operation === 'update' || a.operation === 'create') &&
              (a.contentRef || a.contentSnapshot)
          );

          // P1 Security: Filter to pages user has permission to view
          // Drive membership alone doesn't grant page-level content access
          if (pageActivities.length > 0) {
            const uniquePageIds = [...new Set(pageActivities.map(a => a.pageId).filter(Boolean))] as string[];
            const permissions = await getBatchPagePermissions(userId, uniquePageIds);

            // Filter to pages user can view
            const viewablePageIds = new Set(
              Array.from(permissions.entries())
                .filter(([, perm]) => perm?.canView)
                .map(([pageId]) => pageId)
            );

            // Drive admins have view access to all pages in their drives
            const uniqueDriveIds = [...new Set(
              pageActivities.map(a => a.driveId).filter(Boolean)
            )] as string[];

            for (const driveId of uniqueDriveIds) {
              if (await isDriveOwnerOrAdmin(userId, driveId)) {
                for (const activity of pageActivities) {
                  if (activity.driveId === driveId && activity.pageId) {
                    viewablePageIds.add(activity.pageId);
                  }
                }
              }
            }

            pageActivities = pageActivities.filter(
              a => a.pageId && viewablePageIds.has(a.pageId)
            );
          }

          if (pageActivities.length > 0) {
            // Convert to ActivityForDiff format
            // Note: Content in activity logs is pre-update state (for rollback)
            const activitiesForDiff: (ActivityForDiff & { driveId: string })[] = [];
            // Track contentRefs separately for version resolution
            const activityContentRefs = new Map<string, string>();

            for (const activity of pageActivities) {
              // Track contentRef separately for version resolution
              if (activity.contentRef) {
                activityContentRefs.set(activity.id, activity.contentRef);
              }

              activitiesForDiff.push({
                id: activity.id,
                timestamp: activity.timestamp,
                pageId: activity.pageId,
                resourceTitle: activity.resourceTitle,
                changeGroupId: activity.changeGroupId,
                aiConversationId: activity.aiConversationId,
                isAiGenerated: activity.isAiGenerated,
                actorEmail: activity.actorEmail,
                actorDisplayName: activity.actorDisplayName,
                // Store inline snapshot for fallback (legacy data without contentRef)
                content: activity.contentSnapshot ?? null,
                driveId: activity.driveId!,
              });
            }

            // Group activities for diffing
            const diffGroups = groupActivitiesForDiff(activitiesForDiff);

            // P2 Semantic: Use page versions for post-update content
            // Activity logs store pre-update content; page versions store post-update content
            // Use LAST activity's changeGroupId (AI sessions have multiple changeGroupIds per group)
            const groupsWithChangeGroupId = diffGroups.filter(
              (g) => g.last.changeGroupId && g.last.pageId
            );

            // Resolve post-update content from page versions
            const versionContentPairs = await resolveStackedVersionContent(
              groupsWithChangeGroupId.map((g) => ({
                changeGroupId: g.last.changeGroupId!,
                pageId: g.last.pageId!,
                // Use FIRST activity's contentRef as "before" state (from the Map)
                firstContentRef: activityContentRefs.get(g.first.id) ?? null,
              }))
            );

            // Build DiffRequests for budget-aware generation
            const diffRequests: DiffRequest[] = [];

            for (const group of diffGroups) {
              const firstActivity = activitiesForDiff.find((a) => a.id === group.first.id);
              if (!firstActivity || !firstActivity.pageId) continue;

              // Resolve before/after content
              let beforeContent: string | null = null;
              let afterContent: string | null = null;

              if (group.last.changeGroupId && group.last.pageId) {
                // Use version resolver for accurate before/after
                // Composite key prevents cross-page content leaks
                const compositeKey = `${group.last.pageId}:${group.last.changeGroupId}`;
                const versionPair = versionContentPairs.get(compositeKey);
                if (versionPair) {
                  // Resolve content refs to actual content
                  if (versionPair.beforeContentRef) {
                    try {
                      beforeContent = await readPageContent(versionPair.beforeContentRef);
                    } catch {
                      beforeContent = null;
                    }
                  }
                  if (versionPair.afterContentRef) {
                    try {
                      afterContent = await readPageContent(versionPair.afterContentRef);
                    } catch {
                      afterContent = null;
                    }
                  }
                }
              }

              // Fallback: use inline snapshot if no contentRef and no version found
              if (beforeContent === null && firstActivity.content) {
                beforeContent = firstActivity.content;
              }

              // Skip if we can't generate a meaningful diff
              if (afterContent === null && firstActivity.content) {
                continue;
              }
              if (beforeContent === null && afterContent === null) {
                continue;
              }

              diffRequests.push({
                pageId: firstActivity.pageId,
                beforeContent,
                afterContent,
                group,
                driveId: firstActivity.driveId,
              });
            }

            // P2 Budget: Generate diffs within budget, prioritized by change magnitude
            const budgetedDiffs = generateDiffsWithinBudget(diffRequests, diffBudget);

            // Assign diffs to their respective drive groups
            for (const diff of budgetedDiffs) {
              const driveGroup = driveGroups.find((g) => g.drive.id === diff.driveId);
              if (driveGroup) {
                if (!driveGroup.contentDiffs) {
                  driveGroup.contentDiffs = [];
                }
                // Convert to ContentDiffSummary (strip driveId)
                driveGroup.contentDiffs.push({
                  pageId: diff.pageId,
                  pageTitle: diff.pageTitle,
                  collapsedCount: diff.collapsedCount,
                  timeRange: diff.timeRange,
                  actors: diff.actors,
                  unifiedDiff: diff.unifiedDiff,
                  stats: {
                    additions: diff.stats.additions,
                    deletions: diff.stats.deletions,
                  },
                  isAiGenerated: diff.isAiGenerated,
                });
              }
            }
          }
        }

        // Calculate overall summary
        const totalActivities = activities.length;
        const totalAiGenerated = activities.filter((a) => a.isAiGenerated).length;

        // Build initial response
        const response: {
          ok: boolean;
          actors: CompactActor[];
          drives: CompactDriveGroup[];
          meta: {
            total: number;
            aiTotal: number;
            window: string;
            from: string;
            lastVisit: string | null;
            excludedSelf: boolean;
            truncated?: { droppedDeltas?: boolean; droppedActivities?: number; hardCapExceeded?: boolean };
          };
        } = {
          ok: true,
          actors: actorsList,
          drives: driveGroups,
          meta: {
            total: totalActivities,
            aiTotal: totalAiGenerated,
            window: since,
            from: timeWindowStart.toISOString(),
            lastVisit: lastVisitTime?.toISOString() || null,
            excludedSelf: excludeOwnActivity,
          },
        };

        // Enforce output size limit with progressive degradation
        let outputSize = JSON.stringify(response).length;

        // Step 1: If over limit, drop all deltas
        if (outputSize > maxOutputChars) {
          for (const group of response.drives) {
            for (const activity of group.activities) {
              delete activity.delta;
            }
          }
          response.meta.truncated = { droppedDeltas: true };
          outputSize = JSON.stringify(response).length;
        }

        // Step 2: If still over limit, drop oldest activities using batched approach
        // to avoid expensive JSON.stringify on every single drop
        if (outputSize > maxOutputChars) {
          let droppedCount = 0;
          const targetSize = maxOutputChars * 0.9; // Leave 10% buffer
          const totalActivityCount = response.drives.reduce((sum, g) => sum + g.activities.length, 0);

          // Estimate avg chars per activity (avoid divide by zero)
          const avgActivitySize = totalActivityCount > 0
            ? Math.ceil(outputSize / totalActivityCount)
            : 200;

          // Estimate how many activities to drop
          const excessChars = outputSize - targetSize;
          const estimatedDrops = Math.ceil(excessChars / avgActivitySize);
          const batchSize = Math.max(1, Math.min(10, Math.ceil(estimatedDrops / 5)));

          let dropsSinceLastCheck = 0;
          while (outputSize > targetSize) {
            // Find drive with most activities and drop oldest
            let maxDrive: CompactDriveGroup | null = null;
            for (const group of response.drives) {
              if (!maxDrive || group.activities.length > maxDrive.activities.length) {
                maxDrive = group;
              }
            }

            if (!maxDrive || maxDrive.activities.length <= 1) break;

            // Drop oldest (last in array since sorted desc by timestamp)
            maxDrive.activities.pop();
            maxDrive.stats.total = maxDrive.activities.length;
            droppedCount++;
            dropsSinceLastCheck++;

            // Only re-serialize periodically to check actual size
            if (dropsSinceLastCheck >= batchSize) {
              outputSize = JSON.stringify(response).length;
              dropsSinceLastCheck = 0;
            }
          }

          // Final size check
          if (dropsSinceLastCheck > 0) {
            outputSize = JSON.stringify(response).length;
          }

          if (droppedCount > 0) {
            response.meta.truncated = {
              ...response.meta.truncated,
              droppedActivities: droppedCount,
            };
          }
        }

        // Step 3: If STILL over limit after dropping activities, drop entire drives
        if (outputSize > maxOutputChars && response.drives.length > 1) {
          while (outputSize > maxOutputChars && response.drives.length > 1) {
            // Keep the drive with most activity, drop smallest
            response.drives.sort((a, b) => b.stats.total - a.stats.total);
            response.drives.pop();
            outputSize = JSON.stringify(response).length;
          }
        }

        // Step 4: Last-resort string trimming to enforce hard cap
        // This handles edge cases where a single drive/activity has very large strings
        if (outputSize > maxOutputChars) {
          const maxContextLen = 500;
          const maxTitleLen = 200;

          for (const group of response.drives) {
            // Truncate drive context
            if (group.drive.context && group.drive.context.length > maxContextLen) {
              group.drive.context = group.drive.context.slice(0, maxContextLen) + '…';
            }
            // Truncate activity titles
            for (const activity of group.activities) {
              if (activity.title && activity.title.length > maxTitleLen) {
                activity.title = activity.title.slice(0, maxTitleLen) + '…';
              }
            }
          }

          outputSize = JSON.stringify(response).length;

          // If still over after string truncation, record in truncated meta
          if (outputSize > maxOutputChars) {
            response.meta.truncated = {
              ...response.meta.truncated,
              hardCapExceeded: true,
            };
          }
        }

        // Recompute all derived counters after truncation to ensure consistency
        if (response.meta.truncated) {
          // Reset actor counts
          for (const actor of response.actors) {
            actor.count = 0;
          }

          // Recompute from remaining activities
          let newTotal = 0;
          let newAiTotal = 0;

          for (const group of response.drives) {
            // Reset and recompute drive stats
            group.stats.total = group.activities.length;
            group.stats.byOp = {};
            group.stats.aiCount = 0;

            for (const activity of group.activities) {
              // Update actor count
              if (activity.actor < response.actors.length) {
                response.actors[activity.actor].count++;
              }

              // Update drive stats
              group.stats.byOp[activity.op] = (group.stats.byOp[activity.op] || 0) + 1;
              if (activity.ai) {
                group.stats.aiCount++;
                newAiTotal++;
              }

              newTotal++;
            }
          }

          // Update meta totals
          response.meta.total = newTotal;
          response.meta.aiTotal = newAiTotal;

          // Remove actors with zero count (their activities were all truncated)
          const activeActorIndices = new Map<number, number>();
          const filteredActors: CompactActor[] = [];
          for (let i = 0; i < response.actors.length; i++) {
            if (response.actors[i].count > 0) {
              activeActorIndices.set(i, filteredActors.length);
              filteredActors.push(response.actors[i]);
            }
          }

          // Remap actor indices in activities if any actors were removed
          if (filteredActors.length < response.actors.length) {
            for (const group of response.drives) {
              for (const activity of group.activities) {
                const newIdx = activeActorIndices.get(activity.actor);
                if (newIdx !== undefined) {
                  activity.actor = newIdx;
                }
              }
            }
            response.actors = filteredActors;
          }
        }

        return response;
      } catch (error) {
        console.error('get_activity error:', error);
        throw new Error(
          `Failed to fetch activity: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    },
  }),
};
