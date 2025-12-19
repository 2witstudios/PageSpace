import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database and dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn(),
    query: {
      pages: { findFirst: vi.fn() },
    },
  },
  pages: { id: 'id', type: 'type' },
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: vi.fn(),
  logAgentConfigActivity: vi.fn(),
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
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4) || ''}`),
}));

vi.mock('../../core', () => ({
  pageSpaceTools: {
    list_drives: { name: 'list_drives' },
    list_pages: { name: 'list_pages' },
    read_page: { name: 'read_page' },
  },
}));

import { agentTools } from '../agent-tools';
import { db } from '@pagespace/db';
import { canUserEditPage } from '@pagespace/lib/server';
import type { ToolExecutionContext } from '../../core';

const mockDb = vi.mocked(db);
const mockCanUserEditPage = vi.mocked(canUserEditPage);

describe('agent-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('update_agent_config', () => {
    it('has correct tool definition', () => {
      expect(agentTools.update_agent_config).toBeDefined();
      expect(agentTools.update_agent_config.description).toContain('AI agent');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        agentTools.update_agent_config.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when agent not found', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(null);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        agentTools.update_agent_config.execute!(
          { agentPath: '/drive/agent', agentId: 'non-existent' },
          context
        )
      ).rejects.toThrow('AI agent with ID "non-existent" not found');
    });

    it('throws error when user lacks permission', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
        id: 'agent-1',
        title: 'My Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: null,
        enabledTools: null,
      });
      mockCanUserEditPage.mockResolvedValue(false);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        agentTools.update_agent_config.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1' },
          context
        )
      ).rejects.toThrow('Insufficient permissions to update this AI agent');
    });

    it('validates enabled tools', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
        id: 'agent-1',
        title: 'My Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: null,
        enabledTools: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        agentTools.update_agent_config.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1', enabledTools: ['invalid_tool'] },
          context
        )
      ).rejects.toThrow('Invalid tools specified');
    });

    it('updates agent configuration successfully', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
        id: 'agent-1',
        title: 'My Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: 'Old prompt',
        enabledTools: null,
        aiProvider: null,
        aiModel: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await agentTools.update_agent_config.execute!(
        {
          agentPath: '/drive/agent',
          agentId: 'agent-1',
          systemPrompt: 'New system prompt',
          enabledTools: ['list_drives', 'list_pages'],
        },
        context
      );

      expect((result as { success: boolean }).success).toBe(true);
      expect((result as { title: string }).title).toBe('My Agent');
      expect((result as { agentConfig: { enabledToolsCount: number } }).agentConfig.enabledToolsCount).toBe(2);
    });

    it('updates provider and model settings', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
        id: 'agent-1',
        title: 'My Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: null,
        enabledTools: null,
        aiProvider: null,
        aiModel: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await agentTools.update_agent_config.execute!(
        {
          agentPath: '/drive/agent',
          agentId: 'agent-1',
          aiProvider: 'google',
          aiModel: 'gemini-pro',
        },
        context
      );

      expect((result as { success: boolean }).success).toBe(true);
      expect((result as { agentConfig: { aiProvider: string } }).agentConfig.aiProvider).toBe('google');
      expect((result as { agentConfig: { aiModel: string } }).agentConfig.aiModel).toBe('gemini-pro');

    });
  });
});
