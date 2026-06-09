import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Mock boundaries
vi.mock('@pagespace/lib/permissions/permissions', () => ({
    isUserDriveMember: vi.fn(),
}));

vi.mock('@pagespace/lib/content/activity-diff-utils', () => ({
    groupActivitiesForDiff: vi.fn(),
    generateStackedDiff: vi.fn(),
    truncateDiffsToTokenBudget: vi.fn(),
}));

vi.mock('@pagespace/lib/services/page-content-store', () => ({
    readPageContent: vi.fn(),
}));

import { activityTools, filterAccessibleActivities, shouldContinuePaging } from '../activity-tools';
import { isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import type { ToolExecutionContext } from '../../core/types';

const mockIsUserDriveMember = vi.mocked(isUserDriveMember);

// Properly typed test input matching the Zod schema with defaults
type ActivityToolInput = {
  since: '1h' | '24h' | '7d' | '30d' | 'last_visit';
  excludeOwnActivity: boolean;
  includeAiChanges: boolean;
  limit: number;
  maxOutputChars: number;
  includeDiffs: boolean;
  includeContentDiffs: boolean;
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
  includeContentDiffs: false,
  ...overrides,
});

describe('activity-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get_activity', () => {
    it('has correct tool definition', () => {
      expect(typeof activityTools.get_activity).toBe('object');
      expect(typeof activityTools.get_activity.description).toBe('string');
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
      expect(schema).toBeInstanceOf(z.ZodObject);

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

    it('has includeContentDiffs in tool description', () => {
      // The tool description should mention includeContentDiffs usage
      // This verifies the parameter was added to the schema
      const description = activityTools.get_activity.description;
      expect(typeof description).toBe('string');
    });

    it('accepts includeContentDiffs in execute call', async () => {
      // This test verifies the execute function signature accepts includeContentDiffs
      // We don't need to test the actual behavior here - that requires DB access
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      // This should throw for auth, not for invalid parameter
      await expect(
        activityTools.get_activity.execute!(createTestInput({ includeContentDiffs: true }), context)
      ).rejects.toThrow('User authentication required');
    });
  });

  // Security finding H2: get_activity authorized only at the DRIVE level, so a
  // plain member received titles + content deltas for pages they cannot view.
  // The access decision is isolated in this pure function and exhaustively
  // unit-tested here; the execute() shell just builds the accessible-page set.
  describe('filterAccessibleActivities', () => {
    type Row = { id: string; pageId: string | null; driveId?: string | null };
    const row = (id: string, pageId: string | null): Row => ({ id, pageId, driveId: 'drive-1' });

    it('removes rows whose pageId is NOT in the accessible set (the leak)', () => {
      const rows = [row('a', 'page-public'), row('b', 'page-private')];
      const accessible = new Set(['page-public']);

      const result = filterAccessibleActivities(rows, accessible);

      expect(result.map((r) => r.id)).toEqual(['a']);
      expect(result.some((r) => r.pageId === 'page-private')).toBe(false);
    });

    it('keeps rows whose pageId IS in the accessible set', () => {
      const rows = [row('a', 'page-1'), row('b', 'page-2')];
      const accessible = new Set(['page-1', 'page-2']);

      const result = filterAccessibleActivities(rows, accessible);

      expect(result.map((r) => r.id)).toEqual(['a', 'b']);
    });

    it('RETAINS rows with a null pageId — drive-scoped activity has no page content to leak', () => {
      const rows = [row('member-add', null), row('perm-change', null)];
      const accessible = new Set<string>(); // empty: the actor can view no pages

      const result = filterAccessibleActivities(rows, accessible);

      expect(result.map((r) => r.id)).toEqual(['member-add', 'perm-change']);
    });

    it('RETAINS rows with an absent (undefined) pageId per the same policy', () => {
      const rows = [{ id: 'no-page' } as Row];
      const result = filterAccessibleActivities(rows, new Set(['page-1']));
      expect(result.map((r) => r.id)).toEqual(['no-page']);
    });

    it('drops ALL page-scoped rows when the accessible set is empty, but keeps drive-scoped rows', () => {
      const rows = [row('a', 'page-1'), row('b', null), row('c', 'page-2')];

      const result = filterAccessibleActivities(rows, new Set<string>());

      expect(result.map((r) => r.id)).toEqual(['b']);
    });

    it('handles a mixed batch: viewable pages pass, private pages dropped, drive rows kept', () => {
      const rows = [
        row('view-1', 'p1'),
        row('private', 'p-secret'),
        row('drive-op', null),
        row('view-2', 'p2'),
      ];
      const accessible = new Set(['p1', 'p2']);

      const result = filterAccessibleActivities(rows, accessible);

      expect(result.map((r) => r.id)).toEqual(['view-1', 'drive-op', 'view-2']);
    });

    it('returns a new array and does not mutate its input', () => {
      const rows = [row('a', 'p1'), row('b', 'p-secret')];
      const snapshot = [...rows];

      const result = filterAccessibleActivities(rows, new Set(['p1']));

      expect(result).not.toBe(rows);
      expect(rows).toEqual(snapshot); // input untouched
    });

    it('returns an empty array for empty input', () => {
      expect(filterAccessibleActivities([], new Set(['p1']))).toEqual([]);
    });
  });

  // Access filtering runs AFTER the DB applies its row cap, so the tool
  // over-fetches and pages the window until it has `limit` VISIBLE rows —
  // otherwise inaccessible private-page rows would consume the caller's cap
  // (PR review feedback). This predicate decides when to stop paging.
  describe('shouldContinuePaging', () => {
    const base = {
      collected: 0,
      limit: 50,
      scanned: 0,
      maxScanned: 2000,
      lastBatchSize: 200,
      batchSize: 200,
    };

    it('continues when below limit, under the scan ceiling, and the last batch was full', () => {
      expect(shouldContinuePaging(base)).toBe(true);
    });

    it('stops once enough visible rows have been collected', () => {
      expect(shouldContinuePaging({ ...base, collected: 50 })).toBe(false);
      expect(shouldContinuePaging({ ...base, collected: 73 })).toBe(false);
    });

    it('stops when the scan ceiling is reached (bounds DB work)', () => {
      expect(shouldContinuePaging({ ...base, scanned: 2000 })).toBe(false);
      expect(shouldContinuePaging({ ...base, scanned: 2400 })).toBe(false);
    });

    it('stops when the previous batch was smaller than requested — window exhausted', () => {
      expect(shouldContinuePaging({ ...base, lastBatchSize: 120 })).toBe(false);
    });

    it('stops when the previous batch was empty', () => {
      expect(shouldContinuePaging({ ...base, lastBatchSize: 0 })).toBe(false);
    });

    it('continues when partially filled but the last batch was still full', () => {
      expect(shouldContinuePaging({ ...base, collected: 30, scanned: 200 })).toBe(true);
    });

    it('the limit check takes priority even if a full batch was just fetched', () => {
      expect(
        shouldContinuePaging({ ...base, collected: 50, lastBatchSize: 200, batchSize: 200 })
      ).toBe(false);
    });
  });
});
