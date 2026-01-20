import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

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
import { createAIProvider, saveMessageToDatabase } from '../../core';
import type { ToolExecutionContext } from '../../core';
import { generateText } from 'ai';

const mockDb = vi.mocked(db);
const mockCanUserViewPage = vi.mocked(canUserViewPage);

interface MockDb {
  select: Mock;
  from: Mock;
  where: Mock;
  orderBy: Mock;
  query: {
    pages: { findFirst: Mock };
  };
}

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
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        agentCommunicationTools.list_agents!.execute!(
          { driveId: 'drive-1', includeSystemPrompt: false, includeTools: false },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when drive not found', async () => {
      ((mockDb as unknown as MockDb).where as Mock).mockResolvedValue([]);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await agentCommunicationTools.list_agents!.execute!(
        { driveId: 'non-existent', includeSystemPrompt: false, includeTools: false },
        context
      );

      if (!('error' in result)) throw new Error('Expected error result');
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
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        agentCommunicationTools.multi_drive_list_agents!.execute!(
          { includeSystemPrompt: false, includeTools: false, groupByDrive: false },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

  });

  describe('ask_agent', () => {
    it('has correct tool definition', () => {
      expect(agentCommunicationTools.ask_agent).toBeDefined();
      expect(agentCommunicationTools.ask_agent.description).toContain('Consult');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        agentCommunicationTools.ask_agent!.execute!(
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
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await agentCommunicationTools.ask_agent!.execute!(
        {
          agentPath: '/drive/agent',
          agentId: 'non-existent',
          question: 'Test question',
        },
        context
      );

      if (!('error' in result)) throw new Error('Expected error result');
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
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await agentCommunicationTools.ask_agent!.execute!(
        {
          agentPath: '/drive/agent',
          agentId: 'agent-1',
          question: 'Test question',
        },
        context
      );

      if (!('error' in result)) throw new Error('Expected error result');
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
        toolCallId: '1', messages: [],
        experimental_context: {
          userId: 'user-123',
          agentCallDepth: 3, // MAX_AGENT_DEPTH
        } as ToolExecutionContext & { agentCallDepth: number },
      };

      await expect(
        agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/drive/agent',
            agentId: 'agent-1',
            question: 'Test question',
          },
          context
        )
      ).rejects.toThrow('Maximum agent consultation depth');
    });

    describe('chain context tracking', () => {
      const mockAgent = {
        id: 'agent-1',
        title: 'Test Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: 'I am a helpful agent',
        enabledTools: null,
        aiProvider: null,
        aiModel: null,
        isTrashed: false,
      };

      beforeEach(() => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(mockAgent);
        mockCanUserViewPage.mockResolvedValue(true);
        (mockDb.select as Mock).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        });
        vi.mocked(createAIProvider).mockResolvedValue({
          model: { modelId: 'test-model' } as unknown as ReturnType<typeof createAIProvider> extends Promise<infer T> ? T extends { model: infer M } ? M : never : never,
        } as Awaited<ReturnType<typeof createAIProvider>>);
        vi.mocked(generateText).mockResolvedValue({
          text: 'Agent response',
          steps: [],
        } as unknown as ReturnType<typeof generateText> extends Promise<infer T> ? T : never);
        vi.mocked(saveMessageToDatabase).mockResolvedValue(undefined);
      });

      it('should set parentAgentId from calling agent location context', async () => {
        const parentAgentPageId = 'parent-agent-page-123';
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: {
            userId: 'user-123',
            locationContext: {
              currentPage: { id: parentAgentPageId, title: 'Parent Agent', type: 'AI_CHAT' },
              currentDrive: { id: 'drive-1', name: 'Test Drive', slug: 'test' },
            },
          } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'agent-1',
            question: 'Test question',
          },
          context
        );

        // Verify generateText was called with nested context containing parentAgentId
        expect(generateText).toHaveBeenCalledWith(
          expect.objectContaining({
            experimental_context: expect.objectContaining({
              parentAgentId: parentAgentPageId,
            }),
          })
        );
      });

      it('should append current agent to agentChain', async () => {
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: {
            userId: 'user-123',
            agentChain: ['root-agent'],
          } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'agent-1',
            question: 'Test question',
          },
          context
        );

        // Verify agentChain includes both parent and current agent
        expect(generateText).toHaveBeenCalledWith(
          expect.objectContaining({
            experimental_context: expect.objectContaining({
              agentChain: ['root-agent', 'agent-1'],
            }),
          })
        );
      });

      it('should set requestOrigin to "agent" for nested calls', async () => {
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: {
            userId: 'user-123',
          } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'agent-1',
            question: 'Test question',
          },
          context
        );

        expect(generateText).toHaveBeenCalledWith(
          expect.objectContaining({
            experimental_context: expect.objectContaining({
              requestOrigin: 'agent',
            }),
          })
        );
      });

      it('should preserve parentConversationId from parent context', async () => {
        const parentConversationId = 'parent-conv-123';
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: {
            userId: 'user-123',
            conversationId: parentConversationId,
          } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'agent-1',
            question: 'Test question',
          },
          context
        );

        expect(generateText).toHaveBeenCalledWith(
          expect.objectContaining({
            experimental_context: expect.objectContaining({
              parentConversationId: parentConversationId,
            }),
          })
        );
      });

      it('should accumulate agentChain across multiple nested calls', async () => {
        // Simulate a chain: grandparent -> parent -> current
        const existingChain = ['grandparent-agent', 'parent-agent'];
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: {
            userId: 'user-123',
            agentChain: existingChain,
          } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'agent-1',
            question: 'Test question',
          },
          context
        );

        expect(generateText).toHaveBeenCalledWith(
          expect.objectContaining({
            experimental_context: expect.objectContaining({
              agentChain: ['grandparent-agent', 'parent-agent', 'agent-1'],
            }),
          })
        );
      });

      it('should start fresh agentChain when called directly by user', async () => {
        // No existing agentChain in context
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: {
            userId: 'user-123',
            // No agentChain
          } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'agent-1',
            question: 'Test question',
          },
          context
        );

        expect(generateText).toHaveBeenCalledWith(
          expect.objectContaining({
            experimental_context: expect.objectContaining({
              agentChain: ['agent-1'],
            }),
          })
        );
      });

      it('should increment agentCallDepth for nested context', async () => {
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: {
            userId: 'user-123',
            agentCallDepth: 1,
          } as ToolExecutionContext & { agentCallDepth: number },
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'agent-1',
            question: 'Test question',
          },
          context
        );

        expect(generateText).toHaveBeenCalledWith(
          expect.objectContaining({
            experimental_context: expect.objectContaining({
              agentCallDepth: 2,
            }),
          })
        );
      });
    });

    describe('sourceAgentId tracking', () => {
      const mockAgent = {
        id: 'target-agent-1',
        title: 'Target Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: 'I am a helpful agent',
        enabledTools: null,
        aiProvider: null,
        aiModel: null,
        isTrashed: false,
      };

      beforeEach(() => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(mockAgent);
        mockCanUserViewPage.mockResolvedValue(true);
        (mockDb.select as Mock).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        });
        vi.mocked(createAIProvider).mockResolvedValue({
          model: { modelId: 'test-model' } as unknown as ReturnType<typeof createAIProvider> extends Promise<infer T> ? T extends { model: infer M } ? M : never : never,
        } as Awaited<ReturnType<typeof createAIProvider>>);
        vi.mocked(generateText).mockResolvedValue({
          text: 'Agent response',
          steps: [],
        } as unknown as ReturnType<typeof generateText> extends Promise<infer T> ? T : never);
        vi.mocked(saveMessageToDatabase).mockResolvedValue(undefined);
      });

      it('should pass sourceAgentId when called from an AI_CHAT page', async () => {
        const sourceAgentPageId = 'global-assistant-page-id';
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: {
            userId: 'user-123',
            locationContext: {
              currentPage: { id: sourceAgentPageId, title: 'Global Assistant', type: 'AI_CHAT' },
              currentDrive: { id: 'drive-1', name: 'Test Drive', slug: 'test' },
            },
          } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'target-agent-1',
            question: 'Test question from another agent',
          },
          context
        );

        // Verify saveMessageToDatabase was called with sourceAgentId
        expect(saveMessageToDatabase).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceAgentId: sourceAgentPageId,
          })
        );
      });

      it('should pass null sourceAgentId when called from non-AI_CHAT context', async () => {
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: {
            userId: 'user-123',
            locationContext: {
              currentPage: { id: 'doc-page-id', title: 'Some Document', type: 'DOCUMENT' },
              currentDrive: { id: 'drive-1', name: 'Test Drive', slug: 'test' },
            },
          } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'target-agent-1',
            question: 'Test question',
          },
          context
        );

        // Verify saveMessageToDatabase was called with null sourceAgentId
        expect(saveMessageToDatabase).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceAgentId: null,
          })
        );
      });

      it('should pass null sourceAgentId when no location context', async () => {
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: {
            userId: 'user-123',
            // No locationContext
          } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'target-agent-1',
            question: 'Test question',
          },
          context
        );

        // Verify saveMessageToDatabase was called with null sourceAgentId
        expect(saveMessageToDatabase).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceAgentId: null,
          })
        );
      });
    });
  });
});
