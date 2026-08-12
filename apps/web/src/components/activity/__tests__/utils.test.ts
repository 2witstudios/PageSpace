import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  isRollbackOperation,
  hasAiConversationId,
  isEditSessionGroupable,
  groupConsecutiveActivities,
  dayRangeParams,
  parseDayParam,
  formatDayParam,
} from '../utils';
import type { ActivityLog } from '../types';

/**
 * Factory for creating test ActivityLog objects
 */
function createActivity(overrides: Partial<ActivityLog> = {}): ActivityLog {
  return {
    id: `activity_${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    userId: 'user_1',
    actorEmail: 'test@example.com',
    actorDisplayName: 'Test User',
    operation: 'update',
    resourceType: 'page',
    resourceId: 'page_1',
    resourceTitle: 'Test Page',
    driveId: 'drive_1',
    pageId: 'page_1',
    isAiGenerated: false,
    aiProvider: null,
    aiModel: null,
    aiConversationId: null,
    changeGroupId: null,
    updatedFields: ['content'],
    previousValues: null,
    newValues: null,
    metadata: null,
    rollbackFromActivityId: null,
    rollbackSourceOperation: null,
    rollbackSourceTimestamp: null,
    rollbackSourceTitle: null,
    user: {
      id: 'user_1',
      name: 'Test User',
      email: 'test@example.com',
      image: null,
    },
    ...overrides,
  };
}

describe('Activity Grouping - Predicates', () => {
  describe('isRollbackOperation', () => {
    it('should return true for rollback operations', () => {
      const activity = createActivity({ operation: 'rollback' });
      expect(isRollbackOperation(activity)).toBe(true);
    });

    it('should return false for non-rollback operations', () => {
      const activity = createActivity({ operation: 'update' });
      expect(isRollbackOperation(activity)).toBe(false);
    });
  });

  describe('hasAiConversationId', () => {
    it('should return true when aiConversationId is set', () => {
      const activity = createActivity({ aiConversationId: 'conv_123' });
      expect(hasAiConversationId(activity)).toBe(true);
    });

    it('should return false when aiConversationId is null', () => {
      const activity = createActivity({ aiConversationId: null });
      expect(hasAiConversationId(activity)).toBe(false);
    });
  });

  describe('isEditSessionGroupable', () => {
    it('should return true for user update with changeGroupId', () => {
      const activity = createActivity({
        operation: 'update',
        changeGroupId: 'group_123',
        isAiGenerated: false,
      });
      expect(isEditSessionGroupable(activity)).toBe(true);
    });

    it('should return false for AI-generated updates', () => {
      const activity = createActivity({
        operation: 'update',
        changeGroupId: 'group_123',
        isAiGenerated: true,
      });
      expect(isEditSessionGroupable(activity)).toBe(false);
    });

    it('should return false when changeGroupId is null', () => {
      const activity = createActivity({
        operation: 'update',
        changeGroupId: null,
        isAiGenerated: false,
      });
      expect(isEditSessionGroupable(activity)).toBe(false);
    });

    it('should return false for non-update operations', () => {
      const activity = createActivity({
        operation: 'create',
        changeGroupId: 'group_123',
        isAiGenerated: false,
      });
      expect(isEditSessionGroupable(activity)).toBe(false);
    });
  });
});

describe('groupConsecutiveActivities', () => {
  describe('single activities (no grouping)', () => {
    it('should return single items for non-groupable activities', () => {
      const activities = [
        createActivity({ id: '1', operation: 'create' }),
        createActivity({ id: '2', operation: 'update' }),
        createActivity({ id: '3', operation: 'delete' }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(3);
      expect(result.every((item) => item.type === 'single')).toBe(true);
    });

    it('should return empty array for empty input', () => {
      const result = groupConsecutiveActivities([]);
      expect(result).toHaveLength(0);
    });
  });

  describe('rollback grouping', () => {
    it('should group consecutive rollbacks', () => {
      const activities = [
        createActivity({ id: '1', operation: 'rollback', resourceTitle: 'Page 1' }),
        createActivity({ id: '2', operation: 'rollback', resourceTitle: 'Page 2' }),
        createActivity({ id: '3', operation: 'rollback', resourceTitle: 'Page 3' }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('rollback');
      if (result[0].type !== 'single') {
        expect(result[0].activities).toHaveLength(3);
        expect(result[0].summary.label).toBe('3 rollbacks');
      }
    });

    it('should not group single rollback', () => {
      const activities = [
        createActivity({ id: '1', operation: 'rollback' }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('single');
    });

    it('should split non-consecutive rollbacks', () => {
      const activities = [
        createActivity({ id: '1', operation: 'rollback' }),
        createActivity({ id: '2', operation: 'update' }),
        createActivity({ id: '3', operation: 'rollback' }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(3);
      expect(result.every((item) => item.type === 'single')).toBe(true);
    });
  });

  describe('AI stream grouping', () => {
    it('should group consecutive activities from same AI conversation', () => {
      const activities = [
        createActivity({ id: '1', aiConversationId: 'conv_1', isAiGenerated: true }),
        createActivity({ id: '2', aiConversationId: 'conv_1', isAiGenerated: true }),
        createActivity({ id: '3', aiConversationId: 'conv_1', isAiGenerated: true }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('ai_stream');
      if (result[0].type !== 'single') {
        expect(result[0].activities).toHaveLength(3);
        expect(result[0].summary.label).toMatch(/AI updated \d+ page/);
      }
    });

    it('should not group single AI activity', () => {
      const activities = [
        createActivity({ id: '1', aiConversationId: 'conv_1', isAiGenerated: true }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('single');
    });

    it('should split different AI conversations', () => {
      const activities = [
        createActivity({ id: '1', aiConversationId: 'conv_1', isAiGenerated: true }),
        createActivity({ id: '2', aiConversationId: 'conv_2', isAiGenerated: true }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(2);
      expect(result.every((item) => item.type === 'single')).toBe(true);
    });
  });

  describe('edit session grouping', () => {
    it('should group consecutive edits with same changeGroupId and resourceId', () => {
      const activities = [
        createActivity({ id: '1', changeGroupId: 'group_1', resourceId: 'page_1' }),
        createActivity({ id: '2', changeGroupId: 'group_1', resourceId: 'page_1' }),
        createActivity({ id: '3', changeGroupId: 'group_1', resourceId: 'page_1' }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('edit_session');
      if (result[0].type !== 'single') {
        expect(result[0].activities).toHaveLength(3);
        expect(result[0].summary.label).toMatch(/3 edits to/);
      }
    });

    it('should not group edits with different resourceIds', () => {
      const activities = [
        createActivity({ id: '1', changeGroupId: 'group_1', resourceId: 'page_1' }),
        createActivity({ id: '2', changeGroupId: 'group_1', resourceId: 'page_2' }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(2);
      expect(result.every((item) => item.type === 'single')).toBe(true);
    });

    it('should not group edits with different changeGroupIds', () => {
      const activities = [
        createActivity({ id: '1', changeGroupId: 'group_1', resourceId: 'page_1' }),
        createActivity({ id: '2', changeGroupId: 'group_2', resourceId: 'page_1' }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(2);
      expect(result.every((item) => item.type === 'single')).toBe(true);
    });
  });

  describe('priority order', () => {
    it('should prioritize AI grouping over rollback grouping', () => {
      // If an AI conversation includes rollbacks, they should be grouped as AI stream
      const activities = [
        createActivity({ id: '1', aiConversationId: 'conv_1', operation: 'rollback', isAiGenerated: true }),
        createActivity({ id: '2', aiConversationId: 'conv_1', operation: 'rollback', isAiGenerated: true }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('ai_stream');
    });

    it('should prioritize AI grouping over edit session grouping', () => {
      const activities = [
        createActivity({ id: '1', aiConversationId: 'conv_1', changeGroupId: 'group_1', isAiGenerated: true }),
        createActivity({ id: '2', aiConversationId: 'conv_1', changeGroupId: 'group_1', isAiGenerated: true }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('ai_stream');
    });
  });

  describe('mixed activities', () => {
    it('should correctly handle mixed activity types', () => {
      const activities = [
        // AI stream (2 activities)
        createActivity({ id: '1', aiConversationId: 'conv_1', isAiGenerated: true }),
        createActivity({ id: '2', aiConversationId: 'conv_1', isAiGenerated: true }),
        // Single update
        createActivity({ id: '3', operation: 'update' }),
        // Rollback group (3 activities)
        createActivity({ id: '4', operation: 'rollback' }),
        createActivity({ id: '5', operation: 'rollback' }),
        createActivity({ id: '6', operation: 'rollback' }),
        // Edit session (2 activities)
        createActivity({ id: '7', changeGroupId: 'group_1', resourceId: 'page_x' }),
        createActivity({ id: '8', changeGroupId: 'group_1', resourceId: 'page_x' }),
      ];

      const result = groupConsecutiveActivities(activities);

      expect(result).toHaveLength(4);
      expect(result[0].type).toBe('ai_stream');
      expect(result[1].type).toBe('single');
      expect(result[2].type).toBe('rollback');
      expect(result[3].type).toBe('edit_session');
    });
  });
});

/**
 * The activity filters are a DAY picker over an API that takes instants, and
 * `endDate` is exclusive — so the day the user picked is only included if the
 * bound is the start of the following day. The routes used to add that day
 * themselves in server-local time, which reproduced this window by accident
 * while stretching any explicit instant a caller sent (#2404).
 *
 * TZ is pinned away from UTC because that is the only way these assertions can
 * tell a LOCAL day window from a UTC one.
 */
describe('dayRangeParams', () => {
  const originalTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'America/Chicago'; });
  afterAll(() => {
    // Assigning undefined would leave TZ set to the STRING "undefined".
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('includes the whole of the selected end day', () => {
    // The picker hands back local midnight for each selected day.
    const start = new Date(2026, 1, 10);
    const end = new Date(2026, 1, 19);

    const params = dayRangeParams(start, end);

    expect(params.endDate).toBe(new Date(2026, 1, 20).toISOString());
    // 10 days later, exactly — no DST in that window, and no server involved.
    const span = Date.parse(params.endDate!) - Date.parse(params.startDate!);
    expect(span).toBe(10 * 24 * 60 * 60 * 1000);
  });

  it("describes the viewer's local day, not a UTC one", () => {
    const day = new Date(2026, 1, 19);

    const params = dayRangeParams(day, day);

    // Local midnight in Chicago is 06:00Z, so a UTC-day window would start at
    // 00:00Z. The bounds have to carry the offset or the user gets someone
    // else's day.
    expect(params.startDate).toBe('2026-02-19T06:00:00.000Z');
    expect(params.endDate).toBe('2026-02-20T06:00:00.000Z');
  });

  it('normalises a picked time-of-day down to the start of that day', () => {
    const middleOfDay = new Date(2026, 1, 19, 14, 37, 12);

    expect(dayRangeParams(middleOfDay).startDate).toBe(new Date(2026, 1, 19).toISOString());
  });

  it('omits whichever bound was not picked', () => {
    expect(dayRangeParams(undefined, undefined)).toEqual({});
    expect(dayRangeParams(new Date(2026, 1, 19))).not.toHaveProperty('endDate');
    expect(dayRangeParams(undefined, new Date(2026, 1, 19))).not.toHaveProperty('startDate');
  });
});

/**
 * The filters live in the URL so a view can be reloaded or shared. Both ends of
 * that round trip have a timezone trap, and they fail in OPPOSITE directions:
 *
 * - `new Date("2026-02-19")` is UTC midnight, so it reads back as the 18th
 *   WEST of Greenwich.
 * - `toISOString().split('T')[0]` is the UTC day, so it writes the 18th EAST
 *   of Greenwich (Tokyo midnight is 15:00Z the previous day).
 *
 * Each half is therefore pinned in the hemisphere where it actually breaks —
 * in UTC, and in the other hemisphere, both bugs are invisible.
 */
const withTimezone = (timezone: string) => {
  const originalTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = timezone; });
  afterAll(() => {
    // Assigning undefined would leave TZ set to the STRING "undefined".
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });
};

describe('day URL params, west of Greenwich', () => {
  withTimezone('America/Chicago');

  it('reads a date-only value as the local day, not UTC midnight', () => {
    // `new Date("2026-02-19")` would be Feb 18 18:00 here.
    expect(parseDayParam('2026-02-19')).toEqual(new Date(2026, 1, 19));
  });

  it('survives the round trip a reload or shared link performs', () => {
    const picked = new Date(2026, 1, 19);

    const reloaded = parseDayParam(formatDayParam(picked));

    expect(reloaded).toEqual(picked);
    // And the request built from the reloaded value still covers that same day.
    expect(dayRangeParams(reloaded, reloaded)).toEqual(dayRangeParams(picked, picked));
  });

  it('still honours an explicit instant in the URL', () => {
    expect(parseDayParam('2026-02-19T06:00:00.000Z')).toEqual(new Date('2026-02-19T06:00:00.000Z'));
  });

  it('returns undefined for an absent or unparseable value', () => {
    expect(parseDayParam(null)).toBeUndefined();
    expect(parseDayParam('')).toBeUndefined();
    expect(parseDayParam('not-a-date')).toBeUndefined();
  });
});

describe('day URL params, east of Greenwich', () => {
  withTimezone('Asia/Tokyo');

  it('writes the day the user picked, not the UTC day', () => {
    // Tokyo midnight on the 19th is 15:00Z on the 18th, so the UTC day is a day
    // behind what the picker showed.
    expect(formatDayParam(new Date(2026, 1, 19))).toBe('2026-02-19');
  });

  it('survives the round trip here too', () => {
    const picked = new Date(2026, 1, 19);

    expect(parseDayParam(formatDayParam(picked))).toEqual(picked);
  });
});
