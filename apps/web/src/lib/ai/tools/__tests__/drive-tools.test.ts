import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database - only mock what's actually used in tests
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      drives: { findFirst: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'id', ownerId: 'ownerId' },
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
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn(),
  createDriveEventPayload: vi.fn(),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4) || ''}`),
}));

vi.mock('@pagespace/lib/services/drive-agent-service', () => ({
  listAgentDrives: vi.fn(),
}));
// Stub drive-service so the create-drive tool's allocatePublishSubdomain call
// doesn't pull drive-service's transitive DB-schema imports into this test.
vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccessWithDrive: vi.fn(),
  getDriveById: vi.fn(),
  isValidDriveHomePage: vi.fn(),
  updateDrive: vi.fn(),
  allocatePublishSubdomain: vi.fn().mockResolvedValue('test-drive'),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  logDriveActivity: vi.fn(),
  getActorInfo: vi.fn().mockResolvedValue({ actorType: 'user' }),
}));

vi.mock('../actor-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../actor-permissions')>();
  return {
    ...actual,
    canActorManageDrive: vi.fn().mockResolvedValue(true),
    hasAgentUserScopedAccess: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('@/lib/canvas/publish-page', () => ({
  syncPublishedHomeRoot: vi.fn().mockResolvedValue(undefined),
}));

import { driveTools } from '../drive-tools';
import { db } from '@pagespace/db/db';
import { listAgentDrives } from '@pagespace/lib/services/drive-agent-service';
import { getDriveById, isValidDriveHomePage, updateDrive } from '@pagespace/lib/services/drive-service';
import { syncPublishedHomeRoot } from '@/lib/canvas/publish-page';
import { hasAgentUserScopedAccess } from '../actor-permissions';
import type { ToolExecutionContext } from '../../core/types';

const mockDb = vi.mocked(db);

describe('drive-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list_drives', () => {
    it('has correct tool definition', () => {
      expect(typeof driveTools.list_drives).toBe('object');
      expect(typeof driveTools.list_drives.description).toBe('string');
      expect(driveTools.list_drives.description).toContain('drive');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        driveTools.list_drives.execute!({}, context)
      ).rejects.toThrow('User authentication required');
    });

    it('scopes to the agent\'s drives when called by a page-agent', async () => {
      vi.mocked(listAgentDrives).mockResolvedValue([
        { driveId: 'd1', driveName: 'Home', driveSlug: 'home', role: 'ADMIN', customRoleId: null, isHome: true },
        { driveId: 'd2', driveName: 'Hub', driveSlug: 'hub', role: 'MEMBER', customRoleId: null, isHome: false },
      ]);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: {
          userId: 'user_1',
          chatSource: { type: 'page' as const, agentPageId: 'agent_1' },
        } as ToolExecutionContext,
      };

      const result = await driveTools.list_drives.execute!({}, context) as {
        drives: Array<{ id: string; slug: string; title: string }>;
      };

      expect(listAgentDrives).toHaveBeenCalledWith('agent_1');
      expect(result.drives.map((d) => d.id)).toEqual(['d1', 'd2']);
      // The user-scoped DB query path must not be used for an agent actor.
      expect(mockDb.query.drives.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('create_drive', () => {
    it('has correct tool definition', () => {
      expect(typeof driveTools.create_drive).toBe('object');
      expect(typeof driveTools.create_drive.description).toBe('string');
      expect(driveTools.create_drive.description).toContain('Create');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        driveTools.create_drive.execute!(
          { name: 'Test Drive' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws on empty name', async () => {
      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        driveTools.create_drive.execute!({ name: '' }, context)
      ).rejects.toThrow('Drive name is required');
    });

    it('throws when trying to create Personal drive', async () => {
      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        driveTools.create_drive.execute!({ name: 'Personal' }, context)
      ).rejects.toThrow('Cannot create a drive named "Personal"');
    });

    it('blocks a page-agent without user-scoped access from creating a drive', async () => {
      vi.mocked(hasAgentUserScopedAccess).mockResolvedValue(false);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: {
          userId: 'user_1',
          chatSource: { type: 'page' as const, agentPageId: 'agent_1' },
        } as ToolExecutionContext,
      };

      await expect(
        driveTools.create_drive.execute!({ name: 'Test Drive' }, context)
      ).rejects.toThrow('cannot create new drives');
      expect(hasAgentUserScopedAccess).toHaveBeenCalledWith('agent_1');
    });

    it('lets a page-agent with user-scoped access past the membership gate', async () => {
      vi.mocked(hasAgentUserScopedAccess).mockResolvedValue(true);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: {
          userId: 'user_1',
          chatSource: { type: 'page' as const, agentPageId: 'agent_1' },
        } as ToolExecutionContext,
      };

      // Empty name still fails downstream validation, proving the agent gate
      // let this request through rather than blocking it earlier.
      await expect(
        driveTools.create_drive.execute!({ name: '' }, context)
      ).rejects.toThrow('Drive name is required');
    });

    it('does not consult user-scoped access for a plain user (non-agent) call', async () => {
      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        driveTools.create_drive.execute!({ name: '' }, context)
      ).rejects.toThrow('Drive name is required');
      expect(hasAgentUserScopedAccess).not.toHaveBeenCalled();
    });
  });

  describe('rename_drive', () => {
    it('has correct tool definition', () => {
      expect(typeof driveTools.rename_drive).toBe('object');
      expect(typeof driveTools.rename_drive.description).toBe('string');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        driveTools.rename_drive.execute!(
          { currentName: 'Old Name', driveId: 'drive-1', name: 'New Name' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when drive not found', async () => {
      mockDb.query.drives.findFirst = vi.fn().mockResolvedValue(null);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        driveTools.rename_drive.execute!(
          { currentName: 'My Drive', driveId: 'non-existent', name: 'New Name' },
          context
        )
      ).rejects.toThrow('Drive not found or you do not have permission to rename it');
    });
  });

  describe('set_home_page', () => {
    const authedContext = {
      toolCallId: '1',
      messages: [],
      experimental_context: { userId: 'user-1' } as ToolExecutionContext,
    };

    it('has correct tool definition', () => {
      expect(typeof driveTools.set_home_page).toBe('object');
      expect(typeof driveTools.set_home_page.description).toBe('string');
      expect(driveTools.set_home_page.description).toContain('home');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        driveTools.set_home_page.execute!({ driveId: 'drive-1', pageId: 'page-1' }, context)
      ).rejects.toThrow('User authentication required');
    });

    it('fires syncPublishedHomeRoot (fire-and-forget) after setting the home page', async () => {
      vi.mocked(getDriveById).mockResolvedValue({
        id: 'drive-1', name: 'My Drive', homePageId: null,
      } as Awaited<ReturnType<typeof getDriveById>>);
      vi.mocked(isValidDriveHomePage).mockResolvedValue(true);
      vi.mocked(updateDrive).mockResolvedValue({
        id: 'drive-1', name: 'My Drive', homePageId: 'page-1',
      } as Awaited<ReturnType<typeof updateDrive>>);

      await driveTools.set_home_page.execute!(
        { driveId: 'drive-1', pageId: 'page-1' },
        authedContext,
      );

      expect(syncPublishedHomeRoot).toHaveBeenCalledWith('drive-1');
    });

    it('fires syncPublishedHomeRoot when clearing the home page', async () => {
      vi.mocked(getDriveById).mockResolvedValue({
        id: 'drive-1', name: 'My Drive', homePageId: 'page-1',
      } as Awaited<ReturnType<typeof getDriveById>>);
      vi.mocked(updateDrive).mockResolvedValue({
        id: 'drive-1', name: 'My Drive', homePageId: null,
      } as Awaited<ReturnType<typeof updateDrive>>);

      await driveTools.set_home_page.execute!(
        { driveId: 'drive-1', pageId: null },
        authedContext,
      );

      expect(syncPublishedHomeRoot).toHaveBeenCalledWith('drive-1');
    });
  });
});

// ============================================================================
// Home Drive Guards
// ============================================================================

describe('create_drive — Home name reservation', () => {
  const context = {
    toolCallId: '1', messages: [],
    experimental_context: { userId: 'user-123' } as ToolExecutionContext,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['Home', 'home', 'HOME', '  home  '])(
    'throws for reserved name %j',
    async (name) => {
      await expect(
        driveTools.create_drive.execute!({ name }, context)
      ).rejects.toThrow();
    }
  );
});

describe('rename_drive — Home drive guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when renaming a Home drive', async () => {
    mockDb.query.drives.findFirst = vi.fn().mockResolvedValue({
      id: 'home-drive',
      name: 'Home',
      slug: 'home',
      ownerId: 'user-123',
      kind: 'HOME',
      isTrashed: false,
    });

    const context = {
      toolCallId: '1', messages: [],
      experimental_context: { userId: 'user-123' } as ToolExecutionContext,
    };

    await expect(
      driveTools.rename_drive.execute!(
        { currentName: 'Home', driveId: 'home-drive', name: 'My Space' },
        context
      )
    ).rejects.toThrow();
  });

  it('throws when renaming any drive to a reserved name', async () => {
    const context = {
      toolCallId: '1', messages: [],
      experimental_context: { userId: 'user-123' } as ToolExecutionContext,
    };

    for (const reservedName of ['Home', 'home', 'Personal', 'personal']) {
      mockDb.query.drives.findFirst = vi.fn().mockResolvedValue(null);
      await expect(
        driveTools.rename_drive.execute!(
          { currentName: 'Work', driveId: 'drive-1', name: reservedName },
          context
        )
      ).rejects.toThrow();
    }
  });
});
