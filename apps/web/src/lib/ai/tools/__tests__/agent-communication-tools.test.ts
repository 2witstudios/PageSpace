import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database and dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    orderBy: vi.fn().mockReturnThis(),
    query: {
      pages: { findFirst: vi.fn() },
    },
  },
  pages: { id: 'id', driveId: 'driveId', type: 'type', title: 'title' },
  drives: { id: 'id', ownerId: 'ownerId' },
  chatMessages: { pageId: 'pageId', conversationId: 'conversationId' },
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
  loggers: {
    ai: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('ai', () => ({
  tool: vi.fn((config) => config),
  stepCountIs: vi.fn(() => () => false),
  generateText: vi.fn(),
  convertToModelMessages: vi.fn(),
  UIMessage: {},
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid'),
}));

// Mock sibling tools to avoid circular imports
vi.mock('../drive-tools', () => ({
  driveTools: { list_drives: { name: 'list_drives' } },
}));
vi.mock('../page-read-tools', () => ({
  pageReadTools: { list_pages: { name: 'list_pages' } },
}));
vi.mock('../page-write-tools', () => ({
  pageWriteTools: { create_page: { name: 'create_page' } },
}));
vi.mock('../search-tools', () => ({
  searchTools: { regex_search: { name: 'regex_search' } },
}));
vi.mock('../task-management-tools', () => ({
  taskManagementTools: { update_task: { name: 'update_task' } },
}));
vi.mock('../agent-tools', () => ({
  agentTools: { update_agent_config: { name: 'update_agent_config' } },
}));

// Mock core AI modules
vi.mock('../../core', () => ({
  sanitizeMessagesForModel: vi.fn((msgs) => msgs),
  saveMessageToDatabase: vi.fn(),
  convertDbMessageToUIMessage: vi.fn((msg) => msg),
  createAIProvider: vi.fn(),
  isProviderError: vi.fn(() => false),
  buildTimestampSystemPrompt: vi.fn(() => ''),
  AI_PROVIDERS: { pagespace: { name: 'PageSpace' } },
  getModelDisplayName: vi.fn(() => 'Test Model'),
}));

import { agentCommunicationTools } from '../agent-communication-tools';
import { db } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import type { ToolExecutionContext } from '../../core';

const mockDb = vi.mocked(db);
const mockCanUserViewPage = vi.mocked(canUserViewPage);

describe('agent-communication-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list_agents', () => {
    it('has correct tool definition', () => {
      expect(agentCommunicationTools.list_agents).toBeDefined();
      expect(agentCommunicationTools.list_agents.description).toContain('agent');
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        agentCommunicationTools.list_agents.execute(
          { driveId: 'drive-1' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when drive not found', async () => {
      (mockDb.where as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await agentCommunicationTools.list_agents.execute(
        { driveId: 'non-existent' },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

  });

  describe('multi_drive_list_agents', () => {
    it('has correct tool definition', () => {
      expect(agentCommunicationTools.multi_drive_list_agents).toBeDefined();
      expect(agentCommunicationTools.multi_drive_list_agents.description).toContain('ALL');
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        agentCommunicationTools.multi_drive_list_agents.execute({}, context)
      ).rejects.toThrow('User authentication required');
    });

  });

  describe('ask_agent', () => {
    it('has correct tool definition', () => {
      expect(agentCommunicationTools.ask_agent).toBeDefined();
      expect(agentCommunicationTools.ask_agent.description).toContain('Consult');
    });

    it('requires user authentication', async () => {
      const context = { experimental_context: {} };

      await expect(
        agentCommunicationTools.ask_agent.execute(
          {
            agentPath: '/drive/agent',
            agentId: 'agent-1',
            question: 'What is 2+2?',
          },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when agent not found', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(null);

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await agentCommunicationTools.ask_agent.execute(
        {
          agentPath: '/drive/agent',
          agentId: 'non-existent',
          question: 'Test question',
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('returns error when user lacks permission', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
        id: 'agent-1',
        title: 'Private Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: 'I am helpful',
        enabledTools: null,
        aiProvider: null,
        aiModel: null,
      });
      mockCanUserViewPage.mockResolvedValue(false);

      const context = {
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await agentCommunicationTools.ask_agent.execute(
        {
          agentPath: '/drive/agent',
          agentId: 'agent-1',
          question: 'Test question',
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient permissions');
    });

    it('enforces max recursion depth', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
        id: 'agent-1',
        title: 'Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
      });

      // Context with max depth reached
      const context = {
        experimental_context: {
          userId: 'user-123',
          agentCallDepth: 3, // MAX_AGENT_DEPTH
        } as ToolExecutionContext & { agentCallDepth: number },
      };

      await expect(
        agentCommunicationTools.ask_agent.execute(
          {
            agentPath: '/drive/agent',
            agentId: 'agent-1',
            question: 'Test question',
          },
          context
        )
      ).rejects.toThrow('Maximum agent consultation depth');
    });
  });
});
