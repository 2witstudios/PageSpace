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

import { driveTools } from '../drive-tools';
import { db } from '@pagespace/db/db';
import type { ToolExecutionContext } from '../../core';

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
});
