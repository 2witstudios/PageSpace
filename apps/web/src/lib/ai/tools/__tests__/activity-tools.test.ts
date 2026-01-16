import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Mock boundaries
vi.mock('@pagespace/lib', () => ({
  isUserDriveMember: vi.fn(),
}));

import { activityTools } from '../activity-tools';
import { isUserDriveMember } from '@pagespace/lib';
import type { ToolExecutionContext } from '../../core';

const mockIsUserDriveMember = vi.mocked(isUserDriveMember);

// Properly typed test input matching the Zod schema with defaults
type ActivityToolInput = {
  since: '1h' | '24h' | '7d' | '30d' | 'last_visit';
  excludeOwnActivity: boolean;
  includeAiChanges: boolean;
  limit: number;
  maxOutputChars: number;
  includeDiffs: boolean;
  driveIds?: string[];
  operationCategories?: ('content' | 'permissions' | 'membership')[];
};

// Default values matching the Zod schema defaults
const createTestInput = (overrides: Partial<ActivityToolInput> = {}): ActivityToolInput => ({
  since: '24h',
  excludeOwnActivity: false,
  includeAiChanges: true,
  limit: 50,
  maxOutputChars: 20000,
  includeDiffs: true,
  ...overrides,
});

/**
 * @scaffold - happy path coverage deferred
 *
 * These tests cover authentication and authorization error paths.
 * Happy path tests (actual activity results, grouping, truncation) are deferred
 * because they require either:
 * - An ActivityRepository seam to avoid complex DB mocking, OR
 * - Integration tests against a real database with seeded activity logs
 *
 * TODO: Add integration tests for:
 * - Activity grouping by drive
 * - Compact delta generation
 * - Progressive truncation under size limits
 */
describe('activity-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get_activity', () => {
    it('has correct tool definition', () => {
      expect(activityTools.get_activity).toBeDefined();
      expect(activityTools.get_activity.description).toBeDefined();
      expect(activityTools.get_activity.description).toContain('activity');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        activityTools.get_activity.execute!(createTestInput(), context)
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when specified drive access denied', async () => {
      mockIsUserDriveMember.mockResolvedValue(false);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        activityTools.get_activity.execute!(createTestInput({ driveIds: ['drive-1'] }), context)
      ).rejects.toThrow('No access to any of the specified drives');
    });

    it('has expected input schema shape', () => {
      const schema = activityTools.get_activity.inputSchema;
      expect(schema).toBeDefined();

      // Verify schema is a Zod object using instanceof check
      expect(schema).toBeInstanceOf(z.ZodObject);
    });

    it('description explains use cases', () => {
      const desc = activityTools.get_activity.description;
      expect(desc).toContain('activity');
      expect(desc).toContain('workspace');
      // Should mention key use cases
      expect(desc).toMatch(/collaborat|pulse|welcome|context/i);
    });
  });
});
