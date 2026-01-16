import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock boundaries
vi.mock('@pagespace/lib', () => ({
  isUserDriveMember: vi.fn(),
}));

import { activityTools } from '../activity-tools';
import { isUserDriveMember } from '@pagespace/lib';
import type { ToolExecutionContext } from '../../core';

const mockIsUserDriveMember = vi.mocked(isUserDriveMember);

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

      // Cast to any to bypass Zod's transformed type requirements - schema defaults are applied at runtime
      await expect(
        activityTools.get_activity.execute!(
          { since: '24h' } as Parameters<typeof activityTools.get_activity.execute>[0],
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when specified drive access denied', async () => {
      mockIsUserDriveMember.mockResolvedValue(false);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Cast to any to bypass Zod's transformed type requirements - schema defaults are applied at runtime
      await expect(
        activityTools.get_activity.execute!(
          { since: '24h', driveIds: ['drive-1'] } as Parameters<typeof activityTools.get_activity.execute>[0],
          context
        )
      ).rejects.toThrow('No access to any of the specified drives');
    });

    it('has expected input schema shape', () => {
      const schema = activityTools.get_activity.inputSchema;
      expect(schema).toBeDefined();

      // Verify schema is a Zod object with expected structure
      // Using _def to access internal Zod schema properties
      const def = (schema as { _def?: { typeName?: string } })._def;
      expect(def?.typeName).toBe('ZodObject');
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
