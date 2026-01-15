import { tool } from 'ai';
import { z } from 'zod';
import {
  db,
  activityLogs,
  drives,
  sessions,
  eq,
  and,
  desc,
  gte,
  ne,
  isNull,
  inArray,
} from '@pagespace/db';
import { isUserDriveMember } from '@pagespace/lib';
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
const AUTH_OPERATIONS = ['login', 'logout', 'signup'] as const;

type ContentOperation = typeof CONTENT_OPERATIONS[number];
type PermissionOperation = typeof PERMISSION_OPERATIONS[number];
type MembershipOperation = typeof MEMBERSHIP_OPERATIONS[number];
type AuthOperation = typeof AUTH_OPERATIONS[number];

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

The AI should use this data to form intuition about ongoing work and provide contextually relevant assistance.`,

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
        .max(200)
        .default(100)
        .describe('Maximum total activities to return across all drives'),

      includeDiffs: z
        .boolean()
        .default(true)
        .describe(
          'Include detailed change diffs (previousValues/newValues). Set to false for a lighter response'
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
        includeDiffs,
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
            console.warn(
              `User ${userId} denied access to drives: ${deniedDrives.map((d) => d.driveId).join(', ')}`
            );
          }
        } else {
          // Get all drives user is a member of
          const userDrives = await db
            .select({ id: drives.id })
            .from(drives)
            .where(eq(drives.isTrashed, false));

          // Filter to only drives user has access to
          const accessibleDriveIds: string[] = [];
          for (const drive of userDrives) {
            if (await isUserDriveMember(userId, drive.id)) {
              accessibleDriveIds.push(drive.id);
            }
          }

          targetDriveIds = accessibleDriveIds;
        }

        if (targetDriveIds.length === 0) {
          return {
            success: true,
            driveGroups: [],
            summary: {
              totalActivities: 0,
              timeWindow: since,
              timeWindowStart: timeWindowStart.toISOString(),
              lastVisitTime: lastVisitTime?.toISOString() || null,
            },
            message: 'No accessible drives found',
          };
        }

        // Build operation filter
        let operationFilter: string[] = [];
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
          conditions.push(ne(activityLogs.userId, userId));
        }

        if (!includeAiChanges) {
          conditions.push(eq(activityLogs.isAiGenerated, false));
        }

        if (operationFilter.length > 0) {
          conditions.push(
            inArray(
              activityLogs.operation,
              operationFilter as [string, ...string[]]
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
        const actorMap = new Map<string, { idx: number; name: string | null; isYou: boolean; count: number }>();
        const actorsList: CompactActor[] = [];

        for (const activity of activities) {
          const email = activity.actorEmail;
          if (!actorMap.has(email)) {
            const idx = actorsList.length;
            const actor: CompactActor = {
              email,
              name: activity.actorDisplayName || activity.user?.name || null,
              isYou: activity.userId === userId,
              count: 0,
            };
            actorsList.push(actor);
            actorMap.set(email, { idx, name: actor.name, isYou: actor.isYou, count: 0 });
          }
          actorMap.get(email)!.count++;
        }

        // Update counts in actorsList
        for (const actor of actorsList) {
          actor.count = actorMap.get(actor.email)!.count;
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

        // Calculate overall summary
        const totalActivities = activities.length;
        const totalAiGenerated = activities.filter((a) => a.isAiGenerated).length;

        // Compact response structure optimized for AI context efficiency
        return {
          ok: true,
          actors: actorsList,  // Deduplicated actor list - activities reference by index
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
      } catch (error) {
        console.error('get_activity error:', error);
        throw new Error(
          `Failed to fetch activity: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    },
  }),
};
