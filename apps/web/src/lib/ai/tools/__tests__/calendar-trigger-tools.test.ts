import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

// ============================================================================
// Mock setup — matches conventions from calendar-write-tools.test.ts
// ============================================================================

const {
  mockTransaction,
  mockSelect,
  mockSelectFrom,
  mockSelectWhere,
} = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockSelect: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockSelectWhere: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    select: mockSelect,
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    transaction: mockTransaction,
    query: {
      calendarEvents: { findFirst: vi.fn() },
    },
  },
  calendarEvents: {
    id: 'id',
    driveId: 'driveId',
    createdById: 'createdById',
    metadata: 'metadata',
  },
  calendarTriggers: {
    id: 'id',
    calendarEventId: 'calendarEventId',
    status: 'status',
    scheduledById: 'scheduledById',
  },
  pages: {
    id: 'id',
    type: 'type',
    title: 'title',
    isTrashed: 'isTrashed',
    driveId: 'driveId',
  },
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  isUserDriveMember: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    ai: {
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
  },
}));

vi.mock('@/lib/websocket/calendar-events', () => ({
  broadcastCalendarEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id?.slice(-4) || ''}`),
}));

// Mock timestamp utils — keep parseDateTime simple for tool-level tests
vi.mock('../../core/timestamp-utils', () => ({
  normalizeTimezone: vi.fn((tz: string) => tz || 'UTC'),
  formatDateInTimezone: vi.fn((date: Date) => date.toISOString()),
  parseDateTime: vi.fn((input: string) => {
    // ISO strings
    const d = new Date(input);
    if (!isNaN(d.getTime())) return d;
    // "tomorrow" → future date
    if (input.toLowerCase().includes('tomorrow')) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(15, 0, 0, 0);
      return tomorrow;
    }
    throw new Error(`Could not parse date: "${input}"`);
  }),
}));

import { calendarTriggerTools } from '../calendar-trigger-tools';
import { isUserDriveMember } from '@pagespace/lib';
import type { ToolExecutionContext } from '../../core';

const mockIsUserDriveMember = vi.mocked(isUserDriveMember);

// ============================================================================
// Fixtures
// ============================================================================

const createAuthContext = (userId = 'user-123', timezone = 'UTC') => ({
  toolCallId: '1',
  messages: [],
  experimental_context: { userId, timezone } as ToolExecutionContext,
});

const FUTURE_ISO = new Date(Date.now() + 86_400_000).toISOString(); // tomorrow

const VALID_SCHEDULE_INPUT = {
  title: 'Deploy check',
  triggerAt: FUTURE_ISO,
  agentPageId: 'agent-1',
  driveId: 'drive-1',
  prompt: 'Check deploy status',
};

const MOCK_AGENT_PAGE = {
  id: 'agent-1',
  type: 'AI_CHAT',
  title: 'Deploy Bot',
  isTrashed: false,
  driveId: 'drive-1',
};

// ============================================================================
// schedule_agent_work
// ============================================================================

describe('calendar-trigger-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('schedule_agent_work', () => {
    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        calendarTriggerTools.schedule_agent_work.execute!(VALID_SCHEDULE_INPUT, context)
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when neither prompt nor instructionPageId provided', async () => {
      const input = { ...VALID_SCHEDULE_INPUT, prompt: undefined };

      mockIsUserDriveMember.mockResolvedValue(true);

      // Mock agent page lookup
      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([MOCK_AGENT_PAGE]),
        }),
      });

      const result = await calendarTriggerTools.schedule_agent_work.execute!(
        input as unknown as Parameters<typeof calendarTriggerTools.schedule_agent_work.execute>[0],
        createAuthContext()
      );

      assert({
        given: 'no prompt and no instructionPageId',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'no prompt and no instructionPageId',
        should: 'mention prompt or instructionPageId',
        actual: (result as { error: string }).error.includes('prompt'),
        expected: true,
      });
    });

    it('returns error when user lacks drive access', async () => {
      mockIsUserDriveMember.mockResolvedValue(false);

      const result = await calendarTriggerTools.schedule_agent_work.execute!(
        VALID_SCHEDULE_INPUT,
        createAuthContext()
      );

      assert({
        given: 'user without drive access',
        should: 'return failure',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'user without drive access',
        should: 'mention access',
        actual: (result as { error: string }).error.toLowerCase().includes('access'),
        expected: true,
      });
    });

    it('returns error when agent page not found', async () => {
      mockIsUserDriveMember.mockResolvedValue(true);

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await calendarTriggerTools.schedule_agent_work.execute!(
        VALID_SCHEDULE_INPUT,
        createAuthContext()
      );

      assert({
        given: 'non-existent agent page',
        should: 'return failure',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'non-existent agent page',
        should: 'mention not found',
        actual: (result as { error: string }).error.toLowerCase().includes('not found'),
        expected: true,
      });
    });

    it('returns error when page is not AI_CHAT type', async () => {
      mockIsUserDriveMember.mockResolvedValue(true);

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ ...MOCK_AGENT_PAGE, type: 'DOCUMENT' }]),
        }),
      });

      const result = await calendarTriggerTools.schedule_agent_work.execute!(
        VALID_SCHEDULE_INPUT,
        createAuthContext()
      );

      assert({
        given: 'non-AI_CHAT page type',
        should: 'return failure',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'non-AI_CHAT page type',
        should: 'mention AI_CHAT',
        actual: (result as { error: string }).error.includes('AI_CHAT'),
        expected: true,
      });
    });

    it('returns error when agent page is trashed', async () => {
      mockIsUserDriveMember.mockResolvedValue(true);

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ ...MOCK_AGENT_PAGE, isTrashed: true }]),
        }),
      });

      const result = await calendarTriggerTools.schedule_agent_work.execute!(
        VALID_SCHEDULE_INPUT,
        createAuthContext()
      );

      assert({
        given: 'trashed agent page',
        should: 'return failure',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'trashed agent page',
        should: 'mention trash',
        actual: (result as { error: string }).error.toLowerCase().includes('trash'),
        expected: true,
      });
    });

    it('returns error when agent is a personal page (null driveId)', async () => {
      mockIsUserDriveMember.mockResolvedValue(true);

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ ...MOCK_AGENT_PAGE, driveId: null }]),
        }),
      });

      const result = await calendarTriggerTools.schedule_agent_work.execute!(
        VALID_SCHEDULE_INPUT,
        createAuthContext()
      );

      assert({
        given: 'personal agent page with null driveId',
        should: 'return failure',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'personal agent page',
        should: 'mention personal/drive',
        actual: (result as { error: string }).error.toLowerCase().includes('personal'),
        expected: true,
      });
    });

    it('returns error when user cannot access agent drive (cross-drive)', async () => {
      // First call: user CAN access the target drive
      // Second call: user CANNOT access the agent's different drive
      mockIsUserDriveMember
        .mockResolvedValueOnce(true)   // target driveId check
        .mockResolvedValueOnce(false); // agent.driveId check

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ ...MOCK_AGENT_PAGE, driveId: 'other-drive' }]),
        }),
      });

      const result = await calendarTriggerTools.schedule_agent_work.execute!(
        VALID_SCHEDULE_INPUT,
        createAuthContext()
      );

      assert({
        given: 'agent in inaccessible cross-drive',
        should: 'return failure',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when instruction page is trashed', async () => {
      mockIsUserDriveMember.mockResolvedValue(true);

      // First select: agent page (valid)
      // Second select: instruction page (trashed)
      let selectCallCount = 0;
      mockSelect.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([MOCK_AGENT_PAGE]);
            return Promise.resolve([{ id: 'instr-1', isTrashed: true, driveId: 'drive-1' }]);
          }),
        }),
      }));

      const result = await calendarTriggerTools.schedule_agent_work.execute!(
        { ...VALID_SCHEDULE_INPUT, instructionPageId: 'instr-1' },
        createAuthContext()
      );

      assert({
        given: 'trashed instruction page',
        should: 'return failure',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'trashed instruction page',
        should: 'mention trash',
        actual: (result as { error: string }).error.toLowerCase().includes('trash'),
        expected: true,
      });
    });

    it('returns error when trigger time is in the past', async () => {
      mockIsUserDriveMember.mockResolvedValue(true);

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([MOCK_AGENT_PAGE]),
        }),
      });

      const pastDate = new Date(Date.now() - 86_400_000).toISOString();

      const result = await calendarTriggerTools.schedule_agent_work.execute!(
        { ...VALID_SCHEDULE_INPUT, triggerAt: pastDate },
        createAuthContext()
      );

      assert({
        given: 'trigger time in the past',
        should: 'return failure',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'trigger time in the past',
        should: 'mention future',
        actual: (result as { error: string }).error.toLowerCase().includes('future'),
        expected: true,
      });
    });

    it('does not leak internal error details on DB failure', async () => {
      mockIsUserDriveMember.mockResolvedValue(true);

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([MOCK_AGENT_PAGE]),
        }),
      });

      // Simulate a DB error with internal details during transaction
      mockTransaction.mockRejectedValue(
        new Error('insert or update on table "calendar_triggers" violates foreign key constraint "calendar_triggers_driveId_drives_id_fk"')
      );

      const error = await calendarTriggerTools.schedule_agent_work.execute!(
        VALID_SCHEDULE_INPUT,
        createAuthContext()
      ).catch((e: Error) => e);

      assert({
        given: 'a database error with internal table/constraint names',
        should: 'throw a generic error message, not the raw DB error',
        actual: (error as Error).message.includes('calendar_triggers_driveId'),
        expected: false,
      });

      assert({
        given: 'a database error',
        should: 'still indicate the operation failed',
        actual: (error as Error).message.toLowerCase().includes('failed'),
        expected: true,
      });
    });

    it('creates trigger and calendar event on success', async () => {
      mockIsUserDriveMember.mockResolvedValue(true);

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([MOCK_AGENT_PAGE]),
        }),
      });

      const mockEvent = { id: 'evt-1', driveId: 'drive-1' };
      const mockTrigger = { id: 'trg-1', calendarEventId: 'evt-1' };

      mockTransaction.mockImplementation(async (cb) => {
        const tx = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn()
                .mockResolvedValueOnce([mockEvent])
                .mockResolvedValueOnce([mockTrigger]),
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return cb(tx);
      });

      const result = await calendarTriggerTools.schedule_agent_work.execute!(
        VALID_SCHEDULE_INPUT,
        createAuthContext()
      );

      assert({
        given: 'valid inputs and access',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'successful scheduling',
        should: 'return trigger ID',
        actual: (result as { data: { triggerId: string } }).data.triggerId,
        expected: 'trg-1',
      });

      assert({
        given: 'successful scheduling',
        should: 'return event ID',
        actual: (result as { data: { eventId: string } }).data.eventId,
        expected: 'evt-1',
      });
    });
  });

  // ============================================================================
  // cancel_scheduled_work
  // ============================================================================

  describe('cancel_scheduled_work', () => {
    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        calendarTriggerTools.cancel_scheduled_work.execute!({ triggerId: 'trg-1' }, context)
      ).rejects.toThrow('User authentication required');
    });

    it('cancels a pending trigger owned by the user', async () => {
      const cancelled = {
        id: 'trg-1',
        calendarEventId: 'evt-1',
        driveId: 'drive-1',
        status: 'cancelled',
      };

      mockTransaction.mockImplementation(async (cb) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([cancelled]),
              }),
            }),
          }),
        };
        return cb(tx);
      });

      const result = await calendarTriggerTools.cancel_scheduled_work.execute!(
        { triggerId: 'trg-1' },
        createAuthContext()
      );

      assert({
        given: 'pending trigger owned by the user',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'successful cancel',
        should: 'return cancelled status',
        actual: (result as { data: { status: string } }).data.status,
        expected: 'cancelled',
      });
    });

    it('returns error when trigger not found', async () => {
      // Transaction returns null (no rows matched the atomic update)
      mockTransaction.mockImplementation(async (cb) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        };
        return cb(tx);
      });

      // Follow-up select to determine why — trigger not found
      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await calendarTriggerTools.cancel_scheduled_work.execute!(
        { triggerId: 'trg-nonexistent' },
        createAuthContext()
      );

      assert({
        given: 'non-existent trigger ID',
        should: 'return failure',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'non-existent trigger',
        should: 'mention not found',
        actual: (result as { error: string }).error.toLowerCase().includes('not found'),
        expected: true,
      });
    });

    it('returns error when trigger belongs to another user', async () => {
      mockTransaction.mockImplementation(async (cb) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        };
        return cb(tx);
      });

      // Follow-up select reveals different owner
      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ status: 'pending', scheduledById: 'other-user' }]),
        }),
      });

      const result = await calendarTriggerTools.cancel_scheduled_work.execute!(
        { triggerId: 'trg-1' },
        createAuthContext('user-123')
      );

      assert({
        given: 'trigger owned by another user',
        should: 'return failure',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'wrong owner',
        should: 'mention only the scheduler can cancel',
        actual: (result as { error: string }).error.toLowerCase().includes('scheduled'),
        expected: true,
      });
    });

    it('reports status when trigger is already running', async () => {
      mockTransaction.mockImplementation(async (cb) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        };
        return cb(tx);
      });

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ status: 'running', scheduledById: 'user-123' }]),
        }),
      });

      const result = await calendarTriggerTools.cancel_scheduled_work.execute!(
        { triggerId: 'trg-1' },
        createAuthContext()
      );

      assert({
        given: 'trigger already running',
        should: 'mention running',
        actual: (result as { summary: string }).summary.toLowerCase().includes('running'),
        expected: true,
      });
    });

    it('does not leak internal error details on DB failure', async () => {
      mockTransaction.mockRejectedValue(
        new Error('deadlock detected on table "calendar_triggers"')
      );

      const error = await calendarTriggerTools.cancel_scheduled_work.execute!(
        { triggerId: 'trg-1' },
        createAuthContext()
      ).catch((e: Error) => e);

      assert({
        given: 'a database error with internal details',
        should: 'not leak table name in thrown message',
        actual: (error as Error).message.includes('calendar_triggers'),
        expected: false,
      });

      assert({
        given: 'a database error on cancel',
        should: 'throw a generic failure message',
        actual: (error as Error).message.toLowerCase().includes('failed'),
        expected: true,
      });
    });
  });
});
