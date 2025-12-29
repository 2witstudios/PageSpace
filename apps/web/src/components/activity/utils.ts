import { isToday, isYesterday, isThisWeek, format } from 'date-fns';
import type {
  ActivityLog,
  ActivityGroupSummary,
  ActivityGroupType,
  ActivityDisplayItem,
} from './types';

export function getInitials(name: string | null, email: string): string {
  const trimmedName = name?.trim();
  if (trimmedName) {
    return trimmedName
      .split(' ')
      .filter((n) => n.length > 0)
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  return email.slice(0, 2).toUpperCase();
}

export function groupActivitiesByDate(activities: ActivityLog[]): Map<string, ActivityLog[]> {
  const groups = new Map<string, ActivityLog[]>();

  activities.forEach((activity) => {
    const date = new Date(activity.timestamp);

    // Skip invalid dates
    if (isNaN(date.getTime())) {
      return;
    }

    let groupKey: string;

    if (isToday(date)) {
      groupKey = 'Today';
    } else if (isYesterday(date)) {
      groupKey = 'Yesterday';
    } else if (isThisWeek(date)) {
      groupKey = format(date, 'EEEE'); // Day name
    } else {
      groupKey = format(date, 'MMMM d, yyyy');
    }

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(activity);
  });

  return groups;
}

export function formatDateRange(startDate?: Date, endDate?: Date): string {
  if (!startDate && !endDate) {
    return 'All time';
  }
  if (startDate && endDate) {
    return `${format(startDate, 'MMM d')} - ${format(endDate, 'MMM d, yyyy')}`;
  }
  if (startDate) {
    return `From ${format(startDate, 'MMM d, yyyy')}`;
  }
  if (endDate) {
    return `Until ${format(endDate, 'MMM d, yyyy')}`;
  }
  // All cases are covered above; this should never be reached
  return 'All time';
}

// ============================================================================
// Activity Grouping Functions
// ============================================================================

/**
 * Check if an activity is a rollback operation
 */
export function isRollbackOperation(activity: ActivityLog): boolean {
  return activity.operation === 'rollback';
}

/**
 * Check if an activity has an AI conversation ID (part of an AI stream)
 */
export function hasAiConversationId(activity: ActivityLog): boolean {
  return activity.aiConversationId !== null;
}

/**
 * Check if an activity can be grouped as an edit session
 * (has changeGroupId, is an update operation, and is not AI-generated)
 */
export function isEditSessionGroupable(activity: ActivityLog): boolean {
  return (
    activity.changeGroupId !== null &&
    activity.operation === 'update' &&
    !activity.isAiGenerated
  );
}

/**
 * Collect consecutive activities that are rollback operations with the same changeGroupId
 */
function collectConsecutiveRollbacks(
  activities: ActivityLog[],
  startIndex: number
): ActivityLog[] {
  const firstActivity = activities[startIndex];
  const changeGroupId = firstActivity.changeGroupId;

  const group: ActivityLog[] = [];
  for (let i = startIndex; i < activities.length; i++) {
    const current = activities[i];
    if (
      isRollbackOperation(current) &&
      current.changeGroupId === changeGroupId
    ) {
      group.push(current);
    } else {
      break;
    }
  }
  return group;
}

/**
 * Collect consecutive activities from the same AI conversation
 */
function collectConsecutiveAiStream(
  activities: ActivityLog[],
  startIndex: number
): ActivityLog[] {
  const conversationId = activities[startIndex].aiConversationId;
  if (!conversationId) return [activities[startIndex]];

  const group: ActivityLog[] = [];
  for (let i = startIndex; i < activities.length; i++) {
    if (activities[i].aiConversationId === conversationId) {
      group.push(activities[i]);
    } else {
      break;
    }
  }
  return group;
}

/**
 * Collect consecutive activities from the same edit session
 * (same changeGroupId and same resourceId)
 */
function collectConsecutiveEditSession(
  activities: ActivityLog[],
  startIndex: number
): ActivityLog[] {
  const activity = activities[startIndex];
  const changeGroupId = activity.changeGroupId;
  const resourceId = activity.resourceId;

  if (!changeGroupId) return [activity];

  const group: ActivityLog[] = [];
  for (let i = startIndex; i < activities.length; i++) {
    const current = activities[i];
    if (
      current.changeGroupId === changeGroupId &&
      current.resourceId === resourceId &&
      isEditSessionGroupable(current)
    ) {
      group.push(current);
    } else {
      break;
    }
  }
  return group;
}

/**
 * Get the display name for an activity's actor
 */
function getActorDisplayName(activity: ActivityLog): string {
  return activity.user?.name || activity.actorDisplayName || activity.actorEmail || 'Unknown';
}

/**
 * Create a summary for a group of activities
 */
function createGroupSummary(
  type: ActivityGroupType,
  activities: ActivityLog[]
): ActivityGroupSummary {
  const firstActivity = activities[0];
  const actorName = getActorDisplayName(firstActivity);
  const actorImage = firstActivity.user?.image ?? null;

  let label: string;

  switch (type) {
    case 'rollback': {
      const count = activities.length;
      label = count === 1 ? 'Undo' : `${count} rollbacks`;
      break;
    }
    case 'ai_stream': {
      // Count unique pages affected
      const uniquePages = new Set(activities.map((a) => a.resourceId)).size;
      const pageWord = uniquePages === 1 ? 'page' : 'pages';
      label = `AI updated ${uniquePages} ${pageWord}`;
      break;
    }
    case 'edit_session': {
      const count = activities.length;
      const resourceTitle = firstActivity.resourceTitle || 'Untitled';
      label = `${count} edits to "${resourceTitle}"`;
      break;
    }
  }

  return {
    label,
    actorName,
    actorImage,
    timestamp: firstActivity.timestamp,
  };
}

/**
 * Group consecutive activities into collapsible groups
 *
 * Priority order:
 * 1. AI conversation streams (same aiConversationId)
 * 2. Consecutive rollbacks
 * 3. Edit sessions (same changeGroupId + resourceId)
 * 4. Single activities (no grouping)
 */
export function groupConsecutiveActivities(
  activities: ActivityLog[]
): ActivityDisplayItem[] {
  const result: ActivityDisplayItem[] = [];
  let i = 0;

  while (i < activities.length) {
    const current = activities[i];

    // Priority 1: AI conversation grouping
    if (hasAiConversationId(current)) {
      const group = collectConsecutiveAiStream(activities, i);
      if (group.length > 1) {
        result.push({
          type: 'ai_stream',
          id: `ai_${current.aiConversationId}_${current.id}`,
          activities: group,
          summary: createGroupSummary('ai_stream', group),
        });
        i += group.length;
        continue;
      }
    }

    // Priority 2: Rollback grouping
    if (isRollbackOperation(current)) {
      const group = collectConsecutiveRollbacks(activities, i);
      if (group.length > 1) {
        result.push({
          type: 'rollback',
          id: `rollback_${current.id}`,
          activities: group,
          summary: createGroupSummary('rollback', group),
        });
        i += group.length;
        continue;
      }
    }

    // Priority 3: Edit session grouping
    if (isEditSessionGroupable(current)) {
      const group = collectConsecutiveEditSession(activities, i);
      if (group.length > 1) {
        result.push({
          type: 'edit_session',
          id: `edit_${current.changeGroupId}_${current.id}`,
          activities: group,
          summary: createGroupSummary('edit_session', group),
        });
        i += group.length;
        continue;
      }
    }

    // No grouping - single activity
    result.push({
      type: 'single',
      activity: current,
    });
    i++;
  }

  return result;
}
