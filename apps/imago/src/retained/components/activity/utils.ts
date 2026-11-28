import { isToday, isYesterday, isThisWeek, format, addDays, startOfDay, parseISO } from 'date-fns';
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

/**
 * The instant bounds the activity APIs want for a day-picker range.
 *
 * The picker selects DAYS, in the viewer's own timezone; `startDate`/`endDate`
 * on the API are absolute instants and `endDate` is EXCLUSIVE. So the selected
 * end day is included by sending the start of the *next* local day — which also
 * means the window is the user's day wherever they are, with no day arithmetic
 * on the server, which cannot know their zone.
 *
 * The routes used to add a day themselves, in the server's local time. That
 * happened to reproduce this window (the browser sent local midnight and the
 * server added 24h) but it stretched any explicit instant a caller sent by a
 * whole day, and depended on where the server ran (#2404).
 */
export function dayRangeParams(
  startDate?: Date,
  endDate?: Date,
): { startDate?: string; endDate?: string } {
  return {
    ...(startDate ? { startDate: startOfDay(startDate).toISOString() } : {}),
    ...(endDate ? { endDate: addDays(startOfDay(endDate), 1).toISOString() } : {}),
  };
}

/**
 * Read a day the user picked back out of a URL parameter.
 *
 * The filters live in the URL so a view can be reloaded or shared, and they are
 * written as `YYYY-MM-DD` — a CALENDAR DAY, which only means anything in the
 * reader's own timezone. `new Date("2026-02-19")` is the trap: ISO 8601 defines
 * a bare date as UTC midnight, so west of Greenwich it reads back as the 18th
 * and the whole range slides a day (#2404). `parseISO` reads a date-only value
 * as local midnight, and still honours an explicit instant if one is present.
 */
export function parseDayParam(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = parseISO(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Write a picked day into a URL parameter, as the day the user sees.
 *
 * The counterpart trap to {@link parseDayParam}: `toISOString().split('T')[0]`
 * takes the UTC day, which east of Greenwich is the day BEFORE the one that was
 * picked (Tokyo midnight is 15:00Z the previous day). `format` is local.
 */
export function formatDayParam(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}
