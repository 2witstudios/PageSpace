import { describe, it, expect } from 'vitest';
import { DEFAULT_STATUS_CONFIG } from '../task-status-config';
import type { TaskStatusGroup } from '../task-status-config';

describe('task-status-config', () => {
  describe('DEFAULT_STATUS_CONFIG', () => {
    it('should have pending status with todo group', () => {
      expect(DEFAULT_STATUS_CONFIG.pending).toBeDefined();
      expect(DEFAULT_STATUS_CONFIG.pending.group).toBe('todo');
      expect(DEFAULT_STATUS_CONFIG.pending.label).toBe('To Do');
    });

    it('should have in_progress status with in_progress group', () => {
      expect(DEFAULT_STATUS_CONFIG.in_progress).toBeDefined();
      expect(DEFAULT_STATUS_CONFIG.in_progress.group).toBe('in_progress');
      expect(DEFAULT_STATUS_CONFIG.in_progress.label).toBe('In Progress');
    });

    it('should have completed status with done group', () => {
      expect(DEFAULT_STATUS_CONFIG.completed).toBeDefined();
      expect(DEFAULT_STATUS_CONFIG.completed.group).toBe('done');
      expect(DEFAULT_STATUS_CONFIG.completed.label).toBe('Done');
    });

    it('should have blocked status with in_progress group', () => {
      expect(DEFAULT_STATUS_CONFIG.blocked).toBeDefined();
      expect(DEFAULT_STATUS_CONFIG.blocked.group).toBe('in_progress');
      expect(DEFAULT_STATUS_CONFIG.blocked.label).toBe('Blocked');
    });

    it('should have color classes for each status', () => {
      for (const [, config] of Object.entries(DEFAULT_STATUS_CONFIG)) {
        expect(config.color).toBeTruthy();
        expect(typeof config.color).toBe('string');
      }
    });

    it('should contain exactly four statuses', () => {
      expect(Object.keys(DEFAULT_STATUS_CONFIG)).toHaveLength(4);
    });
  });
});
