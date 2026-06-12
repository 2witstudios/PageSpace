import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ToolExecutionContext } from '../../core/types';

const {
  mockCommandsFindFirst,
  mockCommandsFindMany,
  mockPagesFindFirst,
  mockInsert,
  mockUpdate,
  mockDelete,
  mockSelect,
} = vi.hoisted(() => {
  const mockCommandsFindFirst = vi.fn();
  const mockCommandsFindMany = vi.fn();
  const mockPagesFindFirst = vi.fn();
  const mockSelectWhere = vi.fn().mockResolvedValue([]);
  const mockSelectInnerJoinWhere = vi.fn().mockResolvedValue([]);
  const mockSelectInnerJoin = vi.fn(() => ({ where: mockSelectInnerJoinWhere }));
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere, innerJoin: mockSelectInnerJoin }));
  const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));
  const mockInsert = vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) }));
  const mockUpdate = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn() })) })),
  }));
  const mockDelete = vi.fn(() => ({ where: vi.fn() }));
  return {
    mockCommandsFindFirst,
    mockCommandsFindMany,
    mockPagesFindFirst,
    mockInsert,
    mockUpdate,
    mockDelete,
    mockSelect,
  };
});

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      commands: {
        findFirst: mockCommandsFindFirst,
        findMany: mockCommandsFindMany,
      },
      pages: {
        findFirst: mockPagesFindFirst,
      },
    },
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    select: mockSelect,
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args) => ({ and: args })),
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
  ne: vi.fn((a, b) => ({ ne: [a, b] })),
  or: vi.fn((...args) => ({ or: args })),
  inArray: vi.fn((a, b) => ({ inArray: [a, b] })),
  isNotNull: vi.fn((a) => ({ isNotNull: a })),
}));

vi.mock('@pagespace/db/schema/commands', () => ({
  commands: { id: 'id', userId: 'userId', driveId: 'driveId', trigger: 'trigger' },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'id', ownerId: 'ownerId', isTrashed: 'isTrashed' },
  pages: { id: 'id', driveId: 'driveId', isTrashed: 'isTrashed' },
}));

vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { driveId: 'driveId', userId: 'userId', acceptedAt: 'acceptedAt' },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
  isDriveOwnerOrAdmin: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
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

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id?.slice(-4) || ''}`),
}));

import { commandTools } from '../command-tools';
import { canUserViewPage, isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';

const mockCanUserViewPage = vi.mocked(canUserViewPage);
const mockIsDriveOwnerOrAdmin = vi.mocked(isDriveOwnerOrAdmin);

const ctx: Partial<ToolExecutionContext> = { userId: 'user-1' };

const run = async <T>(
  toolName: keyof typeof commandTools,
  args: Record<string, unknown>,
  context: Partial<ToolExecutionContext> = ctx,
): Promise<T> => {
  const result = await commandTools[toolName].execute!(args as never, {
    toolCallId: '1',
    messages: [],
    experimental_context: context as ToolExecutionContext,
  });
  return result as T;
};

describe('command-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create_command', () => {
    it('has correct tool definition', () => {
      expect(commandTools.create_command).toBeDefined();
      expect(commandTools.create_command.description).toContain('slash command');
    });

    it('throws without authenticated user', async () => {
      await expect(
        run('create_command', { trigger: 'test', description: 'desc', entryPageId: 'page-1' }, {})
      ).rejects.toThrow(/authentication required/i);
    });

    it('rejects invalid trigger (uppercase)', async () => {
      await expect(
        run('create_command', { trigger: 'INVALID', description: 'desc', entryPageId: 'page-1' })
      ).rejects.toThrow(/lowercase/i);
    });

    it('rejects reserved trigger "help"', async () => {
      await expect(
        run('create_command', { trigger: 'help', description: 'desc', entryPageId: 'page-1' })
      ).rejects.toThrow(/reserved/i);
    });

    it('rejects empty description', async () => {
      await expect(
        run('create_command', { trigger: 'my-cmd', description: '   ', entryPageId: 'page-1' })
      ).rejects.toThrow(/empty/i);
    });

    it('rejects drive command when caller is not drive admin', async () => {
      mockIsDriveOwnerOrAdmin.mockResolvedValue(false);
      await expect(
        run('create_command', {
          trigger: 'my-cmd',
          description: 'desc',
          entryPageId: 'page-1',
          driveId: 'drive-1',
        })
      ).rejects.toThrow(/drive owner or admin/i);
    });

    it('creates a personal command successfully', async () => {
      mockCanUserViewPage.mockResolvedValue(true);
      mockPagesFindFirst.mockResolvedValue({ id: 'page-1', driveId: 'drive-1', isTrashed: false });
      mockCommandsFindFirst.mockResolvedValue(null);
      const insertReturning = vi.fn().mockResolvedValue([{
        id: 'cmd-1',
        userId: 'user-1',
        driveId: null,
        trigger: 'my-cmd',
        description: 'desc',
        entryPageId: 'page-1',
        enabled: true,
      }]);
      (mockInsert as Mock).mockReturnValue({ values: vi.fn(() => ({ returning: insertReturning })) });

      const result = await run<{ success: boolean; trigger: string; scope: string }>(
        'create_command',
        { trigger: 'my-cmd', description: 'desc', entryPageId: 'page-1' }
      );

      expect(result.success).toBe(true);
      expect(result.trigger).toBe('my-cmd');
      expect(result.scope).toBe('user');
    });

    it('rejects duplicate trigger in same scope', async () => {
      mockCanUserViewPage.mockResolvedValue(true);
      mockPagesFindFirst.mockResolvedValue({ id: 'page-1', driveId: 'drive-1', isTrashed: false });
      mockCommandsFindFirst.mockResolvedValue({ id: 'existing-cmd' });

      await expect(
        run('create_command', { trigger: 'my-cmd', description: 'desc', entryPageId: 'page-1' })
      ).rejects.toThrow(/already exists/i);
    });

    it('rejects entry page in trash', async () => {
      mockPagesFindFirst.mockResolvedValue({ id: 'page-1', driveId: 'drive-1', isTrashed: true });

      await expect(
        run('create_command', { trigger: 'my-cmd', description: 'desc', entryPageId: 'page-1' })
      ).rejects.toThrow(/trash/i);
    });

    it('rejects when caller cannot view entry page', async () => {
      mockPagesFindFirst.mockResolvedValue({ id: 'page-1', driveId: 'drive-1', isTrashed: false });
      mockCanUserViewPage.mockResolvedValue(false);

      await expect(
        run('create_command', { trigger: 'my-cmd', description: 'desc', entryPageId: 'page-1' })
      ).rejects.toThrow(/access/i);
    });
  });

  describe('update_command', () => {
    it('has correct tool definition', () => {
      expect(commandTools.update_command).toBeDefined();
      expect(commandTools.update_command.description).toContain('Update');
    });

    it('throws without authenticated user', async () => {
      await expect(
        run('update_command', { commandId: 'cmd-1', enabled: false }, {})
      ).rejects.toThrow(/authentication required/i);
    });

    it('throws when no fields provided', async () => {
      await expect(
        run('update_command', { commandId: 'cmd-1' })
      ).rejects.toThrow(/at least one field/i);
    });

    it('returns not found for a non-existent command', async () => {
      mockCommandsFindFirst.mockResolvedValue(null);

      await expect(
        run('update_command', { commandId: 'missing', enabled: false })
      ).rejects.toThrow(/not found/i);
    });

    it('rejects when caller does not own the personal command', async () => {
      mockCommandsFindFirst.mockResolvedValue({
        id: 'cmd-1',
        userId: 'other-user',
        driveId: null,
        trigger: 'my-cmd',
      });

      await expect(
        run('update_command', { commandId: 'cmd-1', enabled: false })
      ).rejects.toThrow(/not found/i);
    });

    it('updates a personal command successfully', async () => {
      mockCommandsFindFirst
        .mockResolvedValueOnce({
          id: 'cmd-1',
          userId: 'user-1',
          driveId: null,
          trigger: 'old-trigger',
        })
        .mockResolvedValueOnce(null); // duplicate check

      const updateReturning = vi.fn().mockResolvedValue([{
        id: 'cmd-1',
        userId: 'user-1',
        driveId: null,
        trigger: 'new-trigger',
        description: 'desc',
        enabled: true,
      }]);
      (mockUpdate as Mock).mockReturnValue({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
      });

      const result = await run<{ success: boolean; trigger: string }>(
        'update_command',
        { commandId: 'cmd-1', trigger: 'new-trigger' }
      );

      expect(result.success).toBe(true);
      expect(result.trigger).toBe('new-trigger');
    });
  });

  describe('delete_command', () => {
    it('has correct tool definition', () => {
      expect(commandTools.delete_command).toBeDefined();
      expect(commandTools.delete_command.description).toContain('Delete');
    });

    it('throws without authenticated user', async () => {
      await expect(run('delete_command', { commandId: 'cmd-1' }, {})).rejects.toThrow(
        /authentication required/i
      );
    });

    it('returns not found for a non-existent command', async () => {
      mockCommandsFindFirst.mockResolvedValue(null);
      await expect(run('delete_command', { commandId: 'missing' })).rejects.toThrow(/not found/i);
    });

    it('deletes a personal command successfully', async () => {
      mockCommandsFindFirst.mockResolvedValue({
        id: 'cmd-1',
        userId: 'user-1',
        driveId: null,
        trigger: 'my-cmd',
      });
      const deleteWhere = vi.fn().mockResolvedValue(undefined);
      (mockDelete as Mock).mockReturnValue({ where: deleteWhere });

      const result = await run<{ success: boolean; trigger: string }>(
        'delete_command',
        { commandId: 'cmd-1' }
      );

      expect(result.success).toBe(true);
      expect(result.trigger).toBe('my-cmd');
      expect(deleteWhere).toHaveBeenCalled();
    });

    it('rejects when caller is not drive admin for a drive command', async () => {
      mockCommandsFindFirst.mockResolvedValue({
        id: 'cmd-1',
        userId: null,
        driveId: 'drive-1',
        trigger: 'shared',
      });
      mockIsDriveOwnerOrAdmin.mockResolvedValue(false);

      await expect(run('delete_command', { commandId: 'cmd-1' })).rejects.toThrow(
        /drive owner or admin/i
      );
    });
  });

  describe('list_commands', () => {
    it('has correct tool definition', () => {
      expect(commandTools.list_commands).toBeDefined();
      expect(commandTools.list_commands.description).toContain('List');
    });

    it('throws without authenticated user', async () => {
      await expect(run('list_commands', {}, {})).rejects.toThrow(/authentication required/i);
    });

    it('returns commands visible to the caller', async () => {
      mockCommandsFindMany.mockResolvedValue([
        {
          id: 'cmd-1',
          userId: 'user-1',
          driveId: null,
          trigger: 'my-cmd',
          description: 'Personal command',
          enabled: true,
          entryPageId: 'page-1',
        },
      ]);

      const result = await run<{ commands: Array<{ trigger: string; scope: string }>; total: number }>(
        'list_commands',
        {}
      );

      expect(result.total).toBe(1);
      expect(result.commands[0].trigger).toBe('my-cmd');
      expect(result.commands[0].scope).toBe('user');
    });

    it('returns empty list when no commands exist', async () => {
      mockCommandsFindMany.mockResolvedValue([]);

      const result = await run<{ commands: unknown[]; total: number }>('list_commands', {});
      expect(result.total).toBe(0);
      expect(result.commands).toEqual([]);
    });

    it('rejects when caller is not a member of the requested drive', async () => {
      // getMemberDriveIds returns [] by default (no owned or member drives)
      await expect(run('list_commands', { driveId: 'drive-not-mine' })).rejects.toThrow(
        /not a member/i
      );
    });

    it('filters to a specific drive when caller is a member', async () => {
      // Simulate user owning 'drive-1' via the owned-drives select query
      (mockSelect as Mock).mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ id: 'drive-1' }]),
          innerJoin: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
        })),
      });
      // second select call (memberships) uses the default mock returning []
      mockCommandsFindMany.mockResolvedValue([
        {
          id: 'cmd-2',
          userId: null,
          driveId: 'drive-1',
          trigger: 'drive-cmd',
          description: 'Drive command',
          enabled: true,
          entryPageId: 'page-2',
        },
      ]);

      const result = await run<{ commands: Array<{ trigger: string; scope: string }>; total: number }>(
        'list_commands',
        { driveId: 'drive-1' }
      );

      expect(result.total).toBe(1);
      expect(result.commands[0].trigger).toBe('drive-cmd');
      expect(result.commands[0].scope).toBe('drive');
    });
  });
});
