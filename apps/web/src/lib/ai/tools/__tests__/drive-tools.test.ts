import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database - only mock what's actually used in tests
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      drives: { findFirst: vi.fn() },
    },
  },
  drives: { id: 'id', ownerId: 'ownerId' },
  eq: vi.fn(),
  and: vi.fn(),
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

vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn(),
  createDriveEventPayload: vi.fn(),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4) || ''}`),
}));

import { driveTools } from '../drive-tools';
import { db } from '@pagespace/db';
import type { ToolExecutionContext } from '../../core';

const mockDb = vi.mocked(db);

/**
 * @scaffold - happy path coverage deferred
 *
 * These tests cover authentication and validation error paths.
 * Happy path tests (list_drives returning data, create_drive success, etc.)
 * are deferred because they require either:
 * - A repository seam to avoid query-builder chain mocking, OR
 * - Integration tests against a real database
 *
 * TODO: Add DriveRepository seam and test happy paths against it.
 */
describe('drive-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list_drives', () => {
    it('has correct tool definition', () => {
      expect(driveTools.list_drives).toBeDefined();
      expect(driveTools.list_drives.description).toBeDefined();
      expect(driveTools.list_drives.description).toContain('drive');
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        driveTools.list_drives.execute({}, context)
      ).rejects.toThrow('User authentication required');
    });
  });

  describe('create_drive', () => {
    it('has correct tool definition', () => {
      expect(driveTools.create_drive).toBeDefined();
      expect(driveTools.create_drive.description).toBeDefined();
      expect(driveTools.create_drive.description).toContain('Create');
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        driveTools.create_drive.execute(
          { name: 'Test Drive' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws on empty name', async () => {
      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        driveTools.create_drive.execute({ name: '' }, context)
      ).rejects.toThrow('Drive name is required');
    });

    it('throws when trying to create Personal drive', async () => {
      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        driveTools.create_drive.execute({ name: 'Personal' }, context)
      ).rejects.toThrow('Cannot create a drive named "Personal"');
    });
  });

  describe('rename_drive', () => {
    it('has correct tool definition', () => {
      expect(driveTools.rename_drive).toBeDefined();
      expect(driveTools.rename_drive.description).toBeDefined();
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        driveTools.rename_drive.execute(
          { driveId: 'drive-1', name: 'New Name' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when drive not found', async () => {
      mockDb.query.drives.findFirst = vi.fn().mockResolvedValue(null);

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        driveTools.rename_drive.execute(
          { driveId: 'non-existent', name: 'New Name' },
          context
        )
      ).rejects.toThrow('Drive not found or you do not have permission to rename it');
    });
  });
});
