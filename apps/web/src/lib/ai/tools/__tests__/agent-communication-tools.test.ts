import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database and dependencies
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    orderBy: vi.fn().mockReturnThis(),
    query: {
      pages: { findFirst: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', type: 'type', title: 'title' },
  drives: { id: 'id', ownerId: 'ownerId' },
  chatMessages: { pageId: 'pageId', conversationId: 'conversationId' },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserViewPage: vi.fn(),
    getUserAccessLevel: vi.fn(),
}));
vi.mock('../actor-permissions', () => ({
  canActorViewPage: vi.fn(),
  canActorEditPage: vi.fn(),
  canActorDeletePage: vi.fn(),
  canActorAccessDrive: vi.fn(),
  getActorAccessiblePagesInDrive: vi.fn(),
  resolveActingAgentId: vi.fn().mockResolvedValue(undefined),
  isMcpScoped: vi.fn(() => false),
  filterDriveIdsByAppTokenScope: vi.fn(async (_ctx: unknown, ids: string[]) => ids),
  filterDriveIdsByMcpScope: vi.fn((_ctx, ids) => ids),
}));
vi.mock('@pagespace/lib/services/drive-agent-service', () => ({
  listAgentDrives: vi.fn(),
  getAgentContextDrives: vi.fn().mockResolvedValue([]),
}));
vi.mock('@pagespace/lib/services/drive-service', () => ({
  listAccessibleDrives: vi.fn().mockResolvedValue([]),
}));
vi.mock('@pagespace/lib/permissions/agent-permissions', () => ({
  getAgentAccessLevel: vi.fn(),
  canAgentViewPage: vi.fn(),
  canAgentEditPage: vi.fn(),
  hasAgentDriveMembership: vi.fn(),
  getAgentAccessiblePagesInDrive: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    ai: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('ai', () => ({
  tool: vi.fn((config) => config),
  stepCountIs: vi.fn(() => () => false),
  hasToolCall: vi.fn(() => () => false),
  generateText: vi.fn(),
  convertToModelMessages: vi.fn(),
  UIMessage: {},
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

// Mock sibling tools to avoid circular imports
vi.mock('../drive-tools', () => ({
  driveTools: { list_drives: { name: 'list_drives' }, create_drive: { name: 'create_drive' } },
}));
vi.mock('../page-read-tools', async () => {
  const { toModelOutputForReadPage } = await import('../read-page-vision-output');
  return {
    pageReadTools: {
      list_pages: { name: 'list_pages' },
      // Mirrors the real read_page tool's toModelOutput wiring (page-read-tools.ts)
      // so the cross-turn vision guard tests exercise the real mapper/guard logic.
      read_page: {
        name: 'read_page',
        toModelOutput: ({ output }: { output: unknown }) => toModelOutputForReadPage(output),
        execute: async () => ({}),
      },
    },
  };
});
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

vi.mock('../../core/integration-tool-resolver', () => ({
  resolvePageAgentIntegrationTools: vi.fn().mockResolvedValue({}),
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { role: 'role' },
}));
vi.mock('../../core/context-assembly', () => ({
  prepareHistoryForModel: vi.fn().mockImplementation(({ history }: { history: unknown[] }) =>
    Promise.resolve({
      messages: history,
      summaryText: '',
      stableBoundaryIndex: 0,
      scheduleCompaction: vi.fn(),
      pendingCompaction: null,
    })
  ),
  // Mirrors the real finisher logic (summary-prepend + pass-through) without
  // calling convertToModelMessages — the conversion is an implementation detail
  // of finishModelRequest; ask_agent tests verify the assembly shape, not the SDK call.
  finishModelRequest: vi.fn().mockImplementation(
    ({ prepared, tail }: { prepared: { summaryText: string; messages: unknown[]; stableBoundaryIndex: number }; tail?: unknown[] }) => {
      const msgs = tail ?? prepared.messages;
      const modelMessages = prepared.summaryText
        ? [{ role: 'user' as const, content: prepared.summaryText }, ...msgs]
        : msgs;
      return { modelMessages, stableBoundaryIndex: prepared.stableBoundaryIndex };
    }
  ),
}));
vi.mock('../../core/compaction/compaction-service', () => ({
  runCompaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: {
    trackUsage: vi.fn(),
    trackToolUsage: vi.fn(),
  },
}));

// Mock core AI modules
vi.mock('../../core/message-utils', () => ({
  sanitizeMessagesForModel: vi.fn((msgs) => msgs),
  saveMessageToDatabase: vi.fn(),
  convertDbMessageToUIMessage: vi.fn((msg) => msg),
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    createConversation: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../core/provider-factory', () => ({
  createAIProvider: vi.fn(),
  isProviderError: vi.fn(() => false),
}));
vi.mock('../../core/timestamp-utils', () => ({
  buildTimestampSystemPrompt: vi.fn(() => ''),
}));
vi.mock('../../core/ai-providers-config', () => ({
  AI_PROVIDERS: { openai: { name: 'OpenAI' } },
  getModelDisplayName: vi.fn(() => 'Test Model'),
  DEFAULT_PROVIDER: 'openai',
  DEFAULT_MODEL: 'openai/gpt-5.3-chat',
}));

import { agentCommunicationTools } from '../agent-communication-tools';
import { db } from '@pagespace/db/db';
import { canActorViewPage, isMcpScoped, resolveActingAgentId, filterDriveIdsByAppTokenScope, filterDriveIdsByMcpScope } from '../actor-permissions';
import { listAgentDrives, getAgentContextDrives } from '@pagespace/lib/services/drive-agent-service';
import { listAccessibleDrives } from '@pagespace/lib/services/drive-service';
import { createAIProvider } from '../../core/provider-factory';
import { saveMessageToDatabase } from '../../core/message-utils';
import type { ToolExecutionContext } from '../../core/types';
import { generateText } from 'ai';
import { resolvePageAgentIntegrationTools } from '../../core/integration-tool-resolver';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { prepareHistoryForModel, finishModelRequest } from '../../core/context-assembly';
import { runCompaction } from '../../core/compaction/compaction-service';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import type { z } from 'zod';

const mockDb = vi.mocked(db);
const mockCanActorViewPage = vi.mocked(canActorViewPage);

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  query: {
    pages: { findFirst: ReturnType<typeof vi.fn> };
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
      (mockDb as unknown as MockDb).where.mockResolvedValue([]);

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

    it('scopes to the agent\'s drive memberships when called by a page-agent', async () => {
      vi.mocked(resolveActingAgentId).mockResolvedValueOnce('agent_1');
      vi.mocked(listAgentDrives).mockResolvedValue([]);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: {
          userId: 'user_1',
          chatSource: { type: 'page' as const, agentPageId: 'agent_1' },
        } as ToolExecutionContext,
      };

      const result = await agentCommunicationTools.multi_drive_list_agents!.execute!(
        { includeSystemPrompt: false, includeTools: false, groupByDrive: true },
        context
      ) as { totalCount: number; driveCount: number };

      expect(listAgentDrives).toHaveBeenCalledWith('agent_1');
      expect(result.totalCount).toBe(0);
      expect(result.driveCount).toBe(0);
      // The raw ownerId-scoped user query must not be used for an agent actor.
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('falls back to the full user-scoped drive set (owned + member + permission) when the agent has user-scoped access enabled', async () => {
      // resolveActingAgentId resolves to undefined once the agent has opted
      // into user-scoped reach, so the tool falls through to the user path.
      vi.mocked(resolveActingAgentId).mockResolvedValueOnce(undefined);
      vi.mocked(listAccessibleDrives).mockResolvedValueOnce([
        { id: 'd1', name: 'Owned', slug: 'owned' } as never,
        { id: 'd2', name: 'Member-of', slug: 'member-of' } as never,
      ]);
      (mockDb as unknown as MockDb).where.mockResolvedValue([]);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: {
          userId: 'user_1',
          chatSource: { type: 'page' as const, agentPageId: 'agent_1' },
        } as ToolExecutionContext,
      };

      await agentCommunicationTools.multi_drive_list_agents!.execute!(
        { includeSystemPrompt: false, includeTools: false, groupByDrive: true },
        context
      );

      expect(listAgentDrives).not.toHaveBeenCalled();
      expect(listAccessibleDrives).toHaveBeenCalledWith('user_1');
      // Not just owned drives — a drive reached only via membership/page-permission
      // must be scanned too (the bug this test guards against): both d1 and d2
      // must reach the per-drive agent scan, not just the owned one.
      expect(vi.mocked(filterDriveIdsByAppTokenScope)).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining(['d1', 'd2']),
      );
    });

    it('does not consult agent scoping for a plain user (non-agent) call', async () => {
      // No chatSource on the context — resolveActingAgentId resolves to
      // undefined (default mock), matching a plain user / global assistant call.
      vi.mocked(listAccessibleDrives).mockResolvedValueOnce([]);
      (mockDb as unknown as MockDb).where.mockResolvedValue([]);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: { userId: 'user_1' } as ToolExecutionContext,
      };

      await agentCommunicationTools.multi_drive_list_agents!.execute!(
        { includeSystemPrompt: false, includeTools: false, groupByDrive: true },
        context
      );

      expect(listAgentDrives).not.toHaveBeenCalled();
      expect(listAccessibleDrives).toHaveBeenCalledWith('user_1');
    });

  });

  describe('ask_agent', () => {
    beforeEach(() => {
      mockCanActorViewPage.mockResolvedValue(true);
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as never);
      vi.mocked(createAIProvider).mockResolvedValue({
        model: { modelId: 'test-model' } as unknown as ReturnType<typeof createAIProvider> extends Promise<infer T> ? T extends { model: infer M } ? M : never : never,
        provider: 'openai',
        modelName: 'openai/gpt-5.3-chat',
      } as Awaited<ReturnType<typeof createAIProvider>>);
      vi.mocked(generateText).mockResolvedValue({
        text: 'Agent response',
        steps: [],
        totalUsage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
      } as unknown as ReturnType<typeof generateText> extends Promise<infer T> ? T : never);
      vi.mocked(saveMessageToDatabase).mockResolvedValue(undefined);
      vi.mocked(AIMonitoring.trackUsage).mockClear();
    });

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
      mockCanActorViewPage.mockResolvedValue(false);

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
          agentCallDepth: 2, // MAX_AGENT_DEPTH
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
      });

      it('meters the sub-agent run against the resolved model with aggregated usage (PR #1475 leak fix)', async () => {
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

        // ask_agent runs a tool loop (stepCountIs(20)); it must bill the requesting
        // user against the resolved backend model (openai/gpt-5.3-chat), not the unmetered alias,
        // using totalUsage so every round-trip is counted.
        expect(AIMonitoring.trackUsage).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'user-123',
            provider: 'openai',
            model: 'openai/gpt-5.3-chat',
            inputTokens: 100,
            outputTokens: 200,
            totalTokens: 300,
            success: true,
          })
        );
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

        // Verify saveMessageToDatabase was called with sourceAgentId for the user message
        const userMessageCall = vi.mocked(saveMessageToDatabase).mock.calls.find(
          call => call[0].role === 'user'
        );
        expect(userMessageCall).toBeDefined();
        expect(userMessageCall![0]).toMatchObject({
          sourceAgentId: sourceAgentPageId,
          role: 'user',
        });
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

        // Verify saveMessageToDatabase was called with null sourceAgentId for the user message
        const userMessageCall = vi.mocked(saveMessageToDatabase).mock.calls.find(
          call => call[0].role === 'user'
        );
        expect(userMessageCall).toBeDefined();
        expect(userMessageCall![0]).toMatchObject({
          sourceAgentId: null,
          role: 'user',
        });
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

        // Verify saveMessageToDatabase was called with null sourceAgentId for the user message
        const userMessageCall = vi.mocked(saveMessageToDatabase).mock.calls.find(
          call => call[0].role === 'user'
        );
        expect(userMessageCall).toBeDefined();
        expect(userMessageCall![0]).toMatchObject({
          sourceAgentId: null,
          role: 'user',
        });
      });
    });

    describe('conversation listing index (#1837 finding #1)', () => {
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
      });

      it('creates a conversations row so a new conversation is listable', async () => {
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'target-agent-1',
            question: 'New question',
          },
          context
        );

        expect(conversationRepository.createConversation).toHaveBeenCalledWith(
          'mock-cuid',
          'user-123',
          'target-agent-1',
        );
      });

      it('creates the row for a continued conversation too (idempotent upsert)', async () => {
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'target-agent-1',
            question: 'Follow-up',
            conversationId: 'conv-a',
          },
          context
        );

        expect(conversationRepository.createConversation).toHaveBeenCalledWith(
          'conv-a',
          'user-123',
          'target-agent-1',
        );
      });

      // The ownership-conflict guard (a supplied conversationId must not let
      // a different caller claim someone else's conversation — Codex P2 on
      // #1846) now lives inside conversationRepository.createConversation
      // itself, so every caller (including this tool) gets it "for free"
      // without a call-site check. That behavior is unit-tested directly
      // against the repository in
      // apps/web/src/lib/repositories/__tests__/conversation-repository.test.ts;
      // this tool always calls createConversation unconditionally (mocked
      // above), so there's nothing conflict-specific to assert here.
    });

    describe('compaction-aware context assembly', () => {
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
        vi.mocked(createAIProvider).mockResolvedValue({
          model: { modelId: 'test-model' } as never,
          provider: 'openai',
          modelName: 'openai/gpt-5.3-chat',
        } as Awaited<ReturnType<typeof createAIProvider>>);
        vi.mocked(generateText).mockResolvedValue({
          text: 'Agent response',
          steps: [],
          totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        } as never);
      });

      it('prepends the seam summaryText as a user ModelMessage before the converted tail', async () => {
        const summaryText = '<conversation_summary>\nold stuff\n</conversation_summary>';
        const tailMsg = {
          id: 'msg-1',
          role: 'user' as const,
          parts: [{ type: 'text', text: 'current question' }],
          createdAt: new Date(),
        };

        vi.mocked(prepareHistoryForModel).mockResolvedValueOnce({
          messages: [tailMsg] as never,
          summaryText,
          stableBoundaryIndex: 1,
          pendingCompaction: null,
          scheduleCompaction: vi.fn(),
        });

        const context = {
          toolCallId: '1', messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };
        await agentCommunicationTools.ask_agent!.execute!(
          { agentPath: '/test/agent', agentId: 'agent-1', question: 'Test question' },
          context
        );

        // finishModelRequest is called with the prepared context (owns summary-prepend + convert)
        expect(finishModelRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            prepared: expect.objectContaining({ summaryText, messages: [tailMsg] }),
          })
        );
        // generateText receives the summary prepended as a user ModelMessage
        expect(generateText).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: [{ role: 'user', content: summaryText }, tailMsg],
          })
        );
      });

      it('fires runCompaction when the seam returns pendingCompaction', async () => {
        const pendingCompaction = {
          conversationId: 'conv-1',
          source: 'page' as const,
          pageId: 'agent-1',
          userId: 'user-123',
          provider: 'openai',
          model: 'openai/gpt-5.3-chat',
          plan: {
            reason: 'over-soft-threshold' as const,
            cutBeforeIndex: 0,
            estimatedTailTokens: 100,
            messagesToSummarize: [],
            compactedUpToMessageId: null,
            compactedUpToCreatedAt: null,
            currentSummaryVersion: null,
            previousSummary: null,
          },
        };

        vi.mocked(prepareHistoryForModel).mockResolvedValueOnce({
          messages: [] as never,
          summaryText: '',
          stableBoundaryIndex: 0,
          pendingCompaction,
          scheduleCompaction: vi.fn(),
        });

        const context = {
          toolCallId: '1', messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };
        await agentCommunicationTools.ask_agent!.execute!(
          { agentPath: '/test/agent', agentId: 'agent-1', question: 'Test question' },
          context
        );

        expect(runCompaction).toHaveBeenCalledWith(pendingCompaction);
      });
    });

    describe('integration tool resolution', () => {
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
      });

      it('merges integration tools into the generateText tools call', async () => {
        const githubTool = { description: 'List GitHub repos', parameters: {}, execute: vi.fn() };
        vi.mocked(resolvePageAgentIntegrationTools).mockResolvedValue({
          github_list_repos: githubTool,
        } as never);

        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1', question: 'List my repos' },
          context
        );

        expect(generateText).toHaveBeenCalledWith(
          expect.objectContaining({
            tools: expect.objectContaining({ github_list_repos: githubTool }),
          })
        );
      });

      it('falls back to built-in tools only when integration resolver throws', async () => {
        vi.mocked(resolvePageAgentIntegrationTools).mockRejectedValue(
          new Error('DB connection failed')
        );

        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        // Should not throw — error is caught and logged
        await expect(
          agentCommunicationTools.ask_agent!.execute!(
            { agentPath: '/drive/agent', agentId: 'agent-1', question: 'Test' },
            context
          )
        ).resolves.not.toThrow();

        // generateText still called; no integration tools in any tools argument
        expect(generateText).toHaveBeenCalled();
        const toolsArg = vi.mocked(generateText).mock.calls[0][0].tools as Record<string, unknown> | undefined;
        // When built-in tool set is empty, generateText is called with no tools at all
        expect(toolsArg?.github_list_repos).toBeUndefined();
      });
    });

    describe('cross-turn vision guard on read_page (PR #1864 follow-up)', () => {
      const visualDeliveredOutput = {
        success: true,
        type: 'visual_content_delivered',
        pageId: 'page-1',
        title: 'diagram.png',
        mimeType: 'image/jpeg',
        originalMimeType: 'image/png',
        message: 'Delivered visual content: "diagram.png" (image/jpeg)',
        imageBase64: 'ZmFrZS1iYXNlNjQ=',
        sizeBytes: 1234,
        metadata: { processingStatus: 'visual', originalFileName: 'diagram.png', presetUsed: 'ai-vision' },
      };

      const mockAgentWithReadPage = (aiModel: string | null) => ({
        id: 'agent-1',
        title: 'Test Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: 'I am a helpful agent',
        enabledTools: ['read_page'],
        aiProvider: null,
        aiModel,
        isTrashed: false,
      });

      it("given the target agent's configured model lacks vision, should degrade a stale visual_content_delivered read_page result instead of re-embedding the image", async () => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(mockAgentWithReadPage('gpt-3.5-turbo'));
        vi.mocked(createAIProvider).mockResolvedValue({
          model: { modelId: 'gpt-3.5-turbo' },
          provider: 'openai',
          modelName: 'gpt-3.5-turbo',
        } as unknown as Awaited<ReturnType<typeof createAIProvider>>);

        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1', question: 'What does this image show?' },
          context
        );

        const toolsArg = vi.mocked(generateText).mock.calls[0][0].tools as Record<string, { toModelOutput?: (args: { output: unknown }) => unknown }> | undefined;
        const readPageTool = toolsArg?.read_page;
        expect(readPageTool?.toModelOutput).toBeDefined();

        const modelOutput = readPageTool!.toModelOutput!({ output: visualDeliveredOutput }) as { type: string; value: Record<string, unknown> };
        expect(modelOutput.type).toBe('json');
        expect(modelOutput.value.type).toBe('visual_content_metadata');
        expect(JSON.stringify(modelOutput)).not.toContain(visualDeliveredOutput.imageBase64);
      });

      it("given the target agent's configured model has vision, should leave read_page's image delivery unguarded", async () => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(mockAgentWithReadPage('openai/gpt-5.4'));
        vi.mocked(createAIProvider).mockResolvedValue({
          model: { modelId: 'openai/gpt-5.4' },
          provider: 'openai',
          modelName: 'openai/gpt-5.4',
        } as unknown as Awaited<ReturnType<typeof createAIProvider>>);

        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1', question: 'What does this image show?' },
          context
        );

        const toolsArg = vi.mocked(generateText).mock.calls[0][0].tools as Record<string, { toModelOutput?: (args: { output: unknown }) => unknown }> | undefined;
        const readPageTool = toolsArg?.read_page;
        expect(readPageTool?.toModelOutput).toBeDefined();

        const modelOutput = readPageTool!.toModelOutput!({ output: visualDeliveredOutput }) as { type: string; value: unknown[] };
        expect(modelOutput.type).toBe('content');
      });
    });

    describe('MCP scope tool filtering (nested agent)', () => {
      const scopedAgent = {
        id: 'agent-1',
        title: 'Test Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: 'I am a helpful agent',
        enabledTools: ['create_drive', 'list_drives'],
        aiProvider: null,
        aiModel: null,
        isTrashed: false,
      };

      beforeEach(() => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(scopedAgent);
        // vi.clearAllMocks() (outer beforeEach) clears call history but not a
        // mockReturnValue override, so pin this back to the module's default
        // (unscoped) each test regardless of execution order.
        vi.mocked(isMcpScoped).mockReturnValue(false);
      });

      it('excludes create_drive from the nested agent tool list when the calling context is a drive-scoped MCP token', async () => {
        vi.mocked(isMcpScoped).mockReturnValue(true);

        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: {
            userId: 'user-123',
            mcpAllowedDriveIds: ['drive-1'],
          } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1', question: 'Make me a new drive' },
          context
        );

        expect(isMcpScoped).toHaveBeenCalled();
        expect(generateText).toHaveBeenCalled();
        const toolsArg = vi.mocked(generateText).mock.calls[0][0].tools as Record<string, unknown> | undefined;
        expect(toolsArg?.create_drive).toBeUndefined();
        expect(toolsArg?.list_drives).toBeDefined();
      });

      it('includes create_drive in the nested agent tool list for an unscoped (session) calling context', async () => {
        vi.mocked(isMcpScoped).mockReturnValue(false);

        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1', question: 'Make me a new drive' },
          context
        );

        expect(generateText).toHaveBeenCalled();
        const toolsArg = vi.mocked(generateText).mock.calls[0][0].tools as Record<string, unknown> | undefined;
        expect(toolsArg?.create_drive).toBeDefined();
        expect(toolsArg?.list_drives).toBeDefined();
      });
    });

    describe('imageAttachments input schema', () => {
      // ask_agent is itself an LLM-callable tool, so this schema is the only
      // gate on untrusted model-supplied input (not just the trusted channel
      // responder). The AI SDK parses tool-call args against inputSchema
      // before execute ever runs, so we exercise the schema directly here.
      const baseInput = { agentPath: '/test/agent', agentId: 'agent-1', question: 'What is this?' };

      it('rejects a non-https, non-data image URL (e.g. an internal/metadata endpoint)', () => {
        const result = (agentCommunicationTools.ask_agent!.inputSchema as unknown as z.ZodTypeAny).safeParse({
          ...baseInput,
          imageAttachments: [{ url: 'http://169.254.169.254/latest/meta-data/', mediaType: 'image/png' }],
        });
        expect(result.success).toBe(false);
      });

      it('accepts an https:// image URL', () => {
        const result = (agentCommunicationTools.ask_agent!.inputSchema as unknown as z.ZodTypeAny).safeParse({
          ...baseInput,
          imageAttachments: [{ url: 'https://example.com/x.png', mediaType: 'image/png' }],
        });
        expect(result.success).toBe(true);
      });

      it('accepts a data: image URL', () => {
        const result = (agentCommunicationTools.ask_agent!.inputSchema as unknown as z.ZodTypeAny).safeParse({
          ...baseInput,
          imageAttachments: [{ url: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png' }],
        });
        expect(result.success).toBe(true);
      });

      it('rejects more than the single-message image cap', () => {
        const tooMany = Array.from({ length: 6 }, (_, i) => ({
          url: `https://example.com/${i}.png`,
          mediaType: 'image/png',
        }));
        const result = (agentCommunicationTools.ask_agent!.inputSchema as unknown as z.ZodTypeAny).safeParse({
          ...baseInput,
          imageAttachments: tooMany,
        });
        expect(result.success).toBe(false);
      });
    });

    describe('imageAttachments', () => {
      const imageAttachments = [
        { url: 'https://example.com/signed/screenshot.png', mediaType: 'image/png', filename: 'screenshot.png' },
      ];

      it('given a vision-capable target agent and imageAttachments, sends file parts to the model but persists only durable text parts', async () => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
          id: 'agent-1',
          title: 'Vision Agent',
          type: 'AI_CHAT',
          driveId: 'drive-1',
          systemPrompt: 'I can see images',
          enabledTools: null,
          aiProvider: 'anthropic',
          aiModel: 'claude-sonnet-4.5',
          isTrashed: false,
        });

        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'agent-1',
            question: 'What is in this screenshot?',
            imageAttachments,
          },
          context
        );

        // The model request (via prepareHistoryForModel) sees the image file parts...
        const historyArg = vi.mocked(prepareHistoryForModel).mock.calls[0][0].history as Array<{
          role: string;
          parts: Array<{ type: string; url?: string; mediaType?: string; filename?: string }>;
        }>;
        const modelUserMessage = historyArg[historyArg.length - 1];
        expect(modelUserMessage.role).toBe('user');
        expect(modelUserMessage.parts).toContainEqual({
          type: 'file',
          url: imageAttachments[0].url,
          mediaType: imageAttachments[0].mediaType,
          filename: imageAttachments[0].filename,
        });

        // ...but the persisted message must not: the presigned URLs expire,
        // and replaying them from history would send dead links to the model.
        const userMessageCall = vi.mocked(saveMessageToDatabase).mock.calls.find(
          (call) => call[0].role === 'user'
        );
        expect(userMessageCall).toBeDefined();
        const savedParts = userMessageCall![0].uiMessage?.parts ?? [];
        expect(savedParts.some((part) => part.type === 'file')).toBe(false);
        const textPart = savedParts.find((part) => part.type === 'text') as { text: string } | undefined;
        expect(textPart?.text).toMatch(/1 image attachment from recent channel context was attached/i);
      });

      it('given a non-vision target agent and imageAttachments, omits file parts and adds a text note instead', async () => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
          id: 'agent-2',
          title: 'Text Agent',
          type: 'AI_CHAT',
          driveId: 'drive-1',
          systemPrompt: 'I am text-only',
          enabledTools: null,
          aiProvider: 'openai',
          aiModel: 'o1-mini',
          isTrashed: false,
        });

        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'agent-2',
            question: 'What is in this screenshot?',
            imageAttachments,
          },
          context
        );

        const userMessageCall = vi.mocked(saveMessageToDatabase).mock.calls.find(
          (call) => call[0].role === 'user'
        );
        expect(userMessageCall).toBeDefined();
        const savedParts = userMessageCall![0].uiMessage?.parts ?? [];
        expect(savedParts.some((part) => part.type === 'file')).toBe(false);
        const textPart = savedParts.find((part) => part.type === 'text') as { text: string } | undefined;
        expect(textPart?.text).toMatch(/does not support vision/i);
        // Grammar: a single attachment must read "1 image attachment WAS
        // provided ... IT could not be viewed", not "were"/"they" (the plural
        // form leaking into the singular case).
        expect(textPart?.text).toMatch(/1 image attachment was provided.*it could not be viewed/i);
      });

      it('given no imageAttachments, behaves exactly as before (no file parts, no vision note)', async () => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue({
          id: 'agent-1',
          title: 'Vision Agent',
          type: 'AI_CHAT',
          driveId: 'drive-1',
          systemPrompt: 'I can see images',
          enabledTools: null,
          aiProvider: 'anthropic',
          aiModel: 'claude-sonnet-4.5',
          isTrashed: false,
        });

        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          {
            agentPath: '/test/agent',
            agentId: 'agent-1',
            question: 'Plain question',
          },
          context
        );

        const userMessageCall = vi.mocked(saveMessageToDatabase).mock.calls.find(
          (call) => call[0].role === 'user'
        );
        expect(userMessageCall).toBeDefined();
        const savedParts = userMessageCall![0].uiMessage?.parts ?? [];
        expect(savedParts).toEqual([{ type: 'text', text: 'Plain question' }]);
      });
    });

    describe('member-drive context injection', () => {
      const memberAgent = {
        id: 'agent-1',
        title: 'Budget Agent',
        type: 'AI_CHAT',
        driveId: 'drive-home',
        systemPrompt: 'I am a helpful agent',
        enabledTools: null,
        aiProvider: null,
        aiModel: null,
        isTrashed: false,
      };

      beforeEach(() => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(memberAgent);
        vi.mocked(getAgentContextDrives).mockResolvedValue([]);
        vi.mocked(filterDriveIdsByMcpScope).mockImplementation((_ctx, ids) => ids);
      });

      it('prepends includeContext=true member-drive drivePrompts to the system prompt', async () => {
        vi.mocked(getAgentContextDrives).mockResolvedValue([
          { driveId: 'drive-marketing', driveName: 'Marketing', drivePrompt: 'Keep replies casual.' },
        ]);

        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1', question: 'What do you think?' },
          context
        );

        expect(getAgentContextDrives).toHaveBeenCalledWith('agent-1');
        const systemArg = vi.mocked(generateText).mock.calls[0][0].system as string;
        expect(systemArg).toContain('## DRIVE CONTEXT: Marketing');
        expect(systemArg).toContain('Keep replies casual.');
      });

      it('leaves the system prompt unchanged when the agent has no includeContext memberships', async () => {
        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: { userId: 'user-123' } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1', question: 'What do you think?' },
          context
        );

        const systemArg = vi.mocked(generateText).mock.calls[0][0].system as string;
        expect(systemArg).not.toContain('DRIVE CONTEXT');
      });

      it('drops member drives outside the caller\'s MCP drive scope', async () => {
        vi.mocked(getAgentContextDrives).mockResolvedValue([
          { driveId: 'drive-marketing', driveName: 'Marketing', drivePrompt: 'Keep replies casual.' },
        ]);
        vi.mocked(filterDriveIdsByMcpScope).mockReturnValue([]);

        const context = {
          toolCallId: '1',
          messages: [],
          experimental_context: {
            userId: 'user-123',
            mcpAllowedDriveIds: ['drive-home'],
          } as ToolExecutionContext,
        };

        await agentCommunicationTools.ask_agent!.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1', question: 'What do you think?' },
          context
        );

        expect(filterDriveIdsByMcpScope).toHaveBeenCalledWith(context.experimental_context, ['drive-marketing']);
        const systemArg = vi.mocked(generateText).mock.calls[0][0].system as string;
        expect(systemArg).not.toContain('DRIVE CONTEXT');
      });
    });
  });
});
