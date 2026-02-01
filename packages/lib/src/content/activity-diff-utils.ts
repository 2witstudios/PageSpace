/**
 * Activity Diff Utilities
 *
 * Utilities for generating stacked content diffs from activity logs.
 * Enables AI to see actual content changes instead of just metadata.
 */

import { generateUnifiedDiff, type DiffStats } from './diff-utils';

/**
 * Represents a stacked diff that collapses multiple saves into a single diff
 */
export interface StackedDiff {
  /** Page ID */
  pageId: string;
  /** Page title (may be null if deleted) */
  pageTitle: string | null;
  /** Change group ID if activities were grouped */
  changeGroupId: string | null;
  /** AI conversation ID if AI-generated changes */
  aiConversationId: string | null;
  /** How many individual saves were collapsed into this diff */
  collapsedCount: number;
  /** Time range of the collapsed changes */
  timeRange: {
    from: string;
    to: string;
  };
  /** Unique actors who made changes (emails or display names) */
  actors: string[];
  /** Git-style unified diff - main content for AI consumption */
  unifiedDiff: string;
  /** Addition/deletion statistics */
  stats: DiffStats;
  /** Whether content was AI-generated */
  isAiGenerated: boolean;
}

/**
 * Minimal activity data needed for diff generation
 */
export interface ActivityForDiff {
  id: string;
  timestamp: string | Date;
  pageId: string | null;
  resourceTitle: string | null;
  changeGroupId: string | null;
  aiConversationId: string | null;
  isAiGenerated: boolean;
  actorEmail: string;
  actorDisplayName: string | null;
  /** Content snapshot (inline or resolved from contentRef) */
  content: string | null;
}

/**
 * Result of grouping activities for diff generation
 */
export interface ActivityDiffGroup {
  /** First activity in the group (earliest) */
  first: ActivityForDiff;
  /** Last activity in the group (most recent) */
  last: ActivityForDiff;
  /** All activities in the group */
  activities: ActivityForDiff[];
  /** Group key used for grouping */
  groupKey: string;
}

/**
 * Groups activities by changeGroupId or aiConversationId for diff generation.
 *
 * Activities are grouped when they share:
 * 1. Same pageId AND same aiConversationId (AI streaming multiple saves)
 * 2. Same pageId AND same changeGroupId (edit session with multiple saves)
 *
 * @param activities - Activities to group (should be sorted by timestamp desc)
 * @returns Array of activity groups, each containing first and last activity for diffing
 */
export function groupActivitiesForDiff(activities: ActivityForDiff[]): ActivityDiffGroup[] {
  if (activities.length === 0) return [];

  // Sort by timestamp ascending (oldest first) for grouping
  const sorted = [...activities].sort((a, b) => {
    const timeA = typeof a.timestamp === 'string' ? new Date(a.timestamp).getTime() : a.timestamp.getTime();
    const timeB = typeof b.timestamp === 'string' ? new Date(b.timestamp).getTime() : b.timestamp.getTime();
    return timeA - timeB;
  });

  const groups = new Map<string, ActivityForDiff[]>();

  for (const activity of sorted) {
    if (!activity.pageId) continue;

    // Build group key: prioritize aiConversationId, then changeGroupId
    let groupKey: string;
    if (activity.aiConversationId) {
      groupKey = `ai:${activity.pageId}:${activity.aiConversationId}`;
    } else if (activity.changeGroupId) {
      groupKey = `cg:${activity.pageId}:${activity.changeGroupId}`;
    } else {
      // Ungrouped - each activity is its own group
      groupKey = `single:${activity.id}`;
    }

    const group = groups.get(groupKey);
    if (group) {
      group.push(activity);
    } else {
      groups.set(groupKey, [activity]);
    }
  }

  // Convert to ActivityDiffGroup array
  const result: ActivityDiffGroup[] = [];
  for (const [groupKey, groupActivities] of groups) {
    if (groupActivities.length === 0) continue;

    result.push({
      first: groupActivities[0],
      last: groupActivities[groupActivities.length - 1],
      activities: groupActivities,
      groupKey,
    });
  }

  return result;
}

/**
 * Generates a stacked diff from activity group.
 *
 * Uses the first activity's content as "before" and last activity's content as "after".
 * Returns a unified diff format familiar to developers.
 *
 * @param firstContent - Content from the first (oldest) activity in the group
 * @param lastContent - Content from the last (most recent) activity in the group
 * @param group - The activity group metadata
 * @returns StackedDiff or null if both contents are null/empty
 */
export function generateStackedDiff(
  firstContent: string | null,
  lastContent: string | null,
  group: ActivityDiffGroup
): StackedDiff | null {
  // If both are null/empty, no diff to generate
  if (!firstContent && !lastContent) {
    return null;
  }

  // Normalize null to empty string for diffing
  const oldContent = firstContent ?? '';
  const newContent = lastContent ?? '';

  // Skip if content is identical
  if (oldContent === newContent) {
    return null;
  }

  // Check for very large content (>50KB) - skip diff generation, return stats only
  const MAX_CONTENT_SIZE = 50 * 1024;
  if (oldContent.length > MAX_CONTENT_SIZE || newContent.length > MAX_CONTENT_SIZE) {
    const additions = newContent.length > oldContent.length ? newContent.length - oldContent.length : 0;
    const deletions = oldContent.length > newContent.length ? oldContent.length - newContent.length : 0;

    return {
      pageId: group.first.pageId!,
      pageTitle: group.last.resourceTitle,
      changeGroupId: group.first.changeGroupId,
      aiConversationId: group.first.aiConversationId,
      collapsedCount: group.activities.length,
      timeRange: {
        from: typeof group.first.timestamp === 'string'
          ? group.first.timestamp
          : group.first.timestamp.toISOString(),
        to: typeof group.last.timestamp === 'string'
          ? group.last.timestamp
          : group.last.timestamp.toISOString(),
      },
      actors: getUniqueActors(group.activities),
      unifiedDiff: '[Content too large for diff - showing stats only]',
      stats: {
        additions,
        deletions,
        unchanged: Math.min(oldContent.length, newContent.length),
        totalChanges: additions + deletions > 0 ? 1 : 0,
      },
      isAiGenerated: group.activities.some(a => a.isAiGenerated),
    };
  }

  // Generate unified diff
  const pageTitle = group.last.resourceTitle ?? 'Untitled';
  const unifiedDiff = generateUnifiedDiff(
    oldContent,
    newContent,
    `${pageTitle} (before)`,
    `${pageTitle} (after)`
  );

  // Calculate stats
  const stats = calculateDiffStats(oldContent, newContent);

  return {
    pageId: group.first.pageId!,
    pageTitle: group.last.resourceTitle,
    changeGroupId: group.first.changeGroupId,
    aiConversationId: group.first.aiConversationId,
    collapsedCount: group.activities.length,
    timeRange: {
      from: typeof group.first.timestamp === 'string'
        ? group.first.timestamp
        : group.first.timestamp.toISOString(),
      to: typeof group.last.timestamp === 'string'
        ? group.last.timestamp
        : group.last.timestamp.toISOString(),
    },
    actors: getUniqueActors(group.activities),
    unifiedDiff,
    stats,
    isAiGenerated: group.activities.some(a => a.isAiGenerated),
  };
}

/**
 * Truncates diffs to fit within a token budget.
 *
 * Prioritizes pages with the largest changes (most additions + deletions).
 * Truncates individual diffs if they exceed per-page limit.
 *
 * @param diffs - Array of stacked diffs
 * @param maxChars - Maximum total characters for all diffs (~4 chars/token)
 * @param maxCharsPerPage - Maximum characters per individual page diff
 * @returns Truncated diffs that fit within budget
 */
export function truncateDiffsToTokenBudget(
  diffs: StackedDiff[],
  maxChars: number = 50000,
  maxCharsPerPage: number = 10000
): StackedDiff[] {
  if (diffs.length === 0) return [];

  // Sort by change magnitude (most significant first)
  const sorted = [...diffs].sort((a, b) => {
    const magA = a.stats.additions + a.stats.deletions;
    const magB = b.stats.additions + b.stats.deletions;
    return magB - magA;
  });

  const result: StackedDiff[] = [];
  let totalChars = 0;

  for (const diff of sorted) {
    // Calculate this diff's contribution to output
    let diffOutput = diff.unifiedDiff;

    // Truncate individual diff if over per-page limit
    if (diffOutput.length > maxCharsPerPage) {
      diffOutput = truncateDiffContent(diffOutput, maxCharsPerPage);
    }

    // Check if adding this diff would exceed budget
    if (totalChars + diffOutput.length > maxChars) {
      // Try to fit a truncated version
      const remainingBudget = maxChars - totalChars;
      if (remainingBudget > 500) { // Minimum useful diff size
        diffOutput = truncateDiffContent(diffOutput, remainingBudget);
        result.push({
          ...diff,
          unifiedDiff: diffOutput,
        });
        totalChars += diffOutput.length;
      }
      break; // No more budget
    }

    result.push({
      ...diff,
      unifiedDiff: diffOutput,
    });
    totalChars += diffOutput.length;
  }

  return result;
}

/**
 * Calculates basic diff statistics without generating full diff
 */
function calculateDiffStats(oldContent: string, newContent: string): DiffStats {
  // Simple character-based stats
  const oldLen = oldContent.length;
  const newLen = newContent.length;

  if (oldLen === newLen && oldContent === newContent) {
    return { additions: 0, deletions: 0, unchanged: oldLen, totalChanges: 0 };
  }

  // For a rough estimate, use length difference
  // This is a simplification - the actual diff-utils provides more accurate stats
  const lengthDiff = newLen - oldLen;

  if (lengthDiff > 0) {
    return {
      additions: lengthDiff,
      deletions: 0,
      unchanged: oldLen,
      totalChanges: 1,
    };
  } else if (lengthDiff < 0) {
    return {
      additions: 0,
      deletions: Math.abs(lengthDiff),
      unchanged: newLen,
      totalChanges: 1,
    };
  } else {
    // Same length but different content
    return {
      additions: newLen,
      deletions: oldLen,
      unchanged: 0,
      totalChanges: 1,
    };
  }
}

/**
 * Gets unique actor names from activities
 */
function getUniqueActors(activities: ActivityForDiff[]): string[] {
  const actors = new Set<string>();
  for (const activity of activities) {
    actors.add(activity.actorDisplayName ?? activity.actorEmail);
  }
  return Array.from(actors);
}

/**
 * Truncates diff content to fit within character limit.
 * Tries to keep complete hunks where possible.
 */
function truncateDiffContent(diffContent: string, maxChars: number): string {
  if (diffContent.length <= maxChars) {
    return diffContent;
  }

  // Try to truncate at a hunk boundary
  const lines = diffContent.split('\n');
  const result: string[] = [];
  let currentLength = 0;

  for (const line of lines) {
    const lineWithNewline = line + '\n';

    if (currentLength + lineWithNewline.length > maxChars - 50) {
      // Leave room for truncation message
      result.push('... [diff truncated - too large] ...');
      break;
    }

    result.push(line);
    currentLength += lineWithNewline.length;
  }

  return result.join('\n');
}
