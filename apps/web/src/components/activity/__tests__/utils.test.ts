import { describe, it, expect } from 'vitest';
import {
  isRollbackOperation,
  hasAiConversationId,
  isEditSessionGroupable,
  groupConsecutiveActivities,
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
