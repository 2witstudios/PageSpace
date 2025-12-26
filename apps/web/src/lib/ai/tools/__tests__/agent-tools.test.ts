import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolExecutionContext } from '../../core';

// Mock repository seams - the proper boundary for tests
vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: vi.fn(),
  getActorInfo: vi.fn().mockResolvedValue({
    actorEmail: 'test@example.com',
    actorDisplayName: 'Test User',
  }),
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
  agentRepository: {
    findById: vi.fn(),
    updateConfig: vi.fn(),
  },
}));

vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: vi.fn(),
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
import { canUserEditPage, agentRepository } from '@pagespace/lib/server';
import { broadcastPageEvent } from '@/lib/websocket';
import { applyPageMutation } from '@/services/api/page-mutation-service';

const mockAgentRepository = vi.mocked(agentRepository);
const mockCanUserEditPage = vi.mocked(canUserEditPage);
const mockBroadcastPageEvent = vi.mocked(broadcastPageEvent);

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
      // Arrange
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      // Act & Assert
      await expect(
        agentTools.update_agent_config.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1' },
          context
        )
      ).rejects.toThrow('User authentication required');

      // Repository should not be called without auth
      expect(mockAgentRepository.findById).not.toHaveBeenCalled();
    });

    it('throws error when agent not found', async () => {
      // Arrange
      mockAgentRepository.findById.mockResolvedValue(null);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act & Assert
      await expect(
        agentTools.update_agent_config.execute!(
          { agentPath: '/drive/agent', agentId: 'non-existent' },
          context
        )
      ).rejects.toThrow('AI agent with ID "non-existent" not found');

      // Verify repository was queried with correct ID
      expect(mockAgentRepository.findById).toHaveBeenCalledWith('non-existent');
    });

    it('throws error when user lacks permission', async () => {
      // Arrange
      const mockAgent = {
        id: 'agent-1',
        title: 'My Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: null,
        enabledTools: null,
        aiProvider: null,
        aiModel: null,
        agentDefinition: null,
        visibleToGlobalAssistant: false,
        includeDrivePrompt: false,
        includePageTree: false,
        pageTreeScope: null,
        revision: 1,
      };
      mockAgentRepository.findById.mockResolvedValue(mockAgent);
      mockCanUserEditPage.mockResolvedValue(false);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act & Assert
      await expect(
        agentTools.update_agent_config.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1' },
          context
        )
      ).rejects.toThrow('Insufficient permissions to update this AI agent');

      // Verify permission check was called with correct params
      expect(mockCanUserEditPage).toHaveBeenCalledWith('user-123', 'agent-1');
      // Verify applyPageMutation was NOT called
      expect(applyPageMutation).not.toHaveBeenCalled();
    });

    it('validates enabled tools against available tools', async () => {
      // Arrange
      const mockAgent = {
        id: 'agent-1',
        title: 'My Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: null,
        enabledTools: null,
        aiProvider: null,
        aiModel: null,
        agentDefinition: null,
        visibleToGlobalAssistant: false,
        includeDrivePrompt: false,
        includePageTree: false,
        pageTreeScope: null,
        revision: 1,
      };
      mockAgentRepository.findById.mockResolvedValue(mockAgent);
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act & Assert
      await expect(
        agentTools.update_agent_config.execute!(
          {
            agentPath: '/drive/agent',
            agentId: 'agent-1',
            enabledTools: ['invalid_tool', 'also_invalid'],
          },
          context
        )
      ).rejects.toThrow('Invalid tools specified');

      // Verify applyPageMutation was NOT called due to validation failure
      expect(applyPageMutation).not.toHaveBeenCalled();
    });

    it('updates agent configuration with system prompt and tools', async () => {
      // Arrange
      const mockAgent = {
        id: 'agent-1',
        title: 'My Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: 'Old prompt',
        enabledTools: null,
        aiProvider: null,
        aiModel: null,
        agentDefinition: null,
        visibleToGlobalAssistant: false,
        includeDrivePrompt: false,
        includePageTree: false,
        pageTreeScope: null,
        revision: 2,
      };
      mockAgentRepository.findById.mockResolvedValue(mockAgent);
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act
      const result = await agentTools.update_agent_config.execute!(
        {
          agentPath: '/drive/agent',
          agentId: 'agent-1',
          systemPrompt: 'New system prompt',
          enabledTools: ['list_drives', 'list_pages'],
        },
        context
      );

      // Assert - verify result payload
      expect(result).toMatchObject({
        success: true,
        id: 'agent-1',
        title: 'My Agent',
        agentConfig: {
          enabledToolsCount: 2,
          enabledTools: ['list_drives', 'list_pages'],
        },
      });

      // Assert - verify mutation was called with correct data
      expect(applyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'agent-1',
          updates: expect.objectContaining({
            systemPrompt: 'New system prompt',
            enabledTools: ['list_drives', 'list_pages'],
          }),
        })
      );

      // Assert - verify broadcast was called
      expect(mockBroadcastPageEvent).toHaveBeenCalled();
    });

    it('updates provider and model settings', async () => {
      // Arrange
      const mockAgent = {
        id: 'agent-1',
        title: 'My Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: null,
        enabledTools: null,
        aiProvider: null,
        aiModel: null,
        agentDefinition: null,
        visibleToGlobalAssistant: false,
        includeDrivePrompt: false,
        includePageTree: false,
        pageTreeScope: null,
        revision: 3,
      };
      mockAgentRepository.findById.mockResolvedValue(mockAgent);
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act
      const result = await agentTools.update_agent_config.execute!(
        {
          agentPath: '/drive/agent',
          agentId: 'agent-1',
          aiProvider: 'google',
          aiModel: 'gemini-pro',
        },
        context
      );

      // Assert - verify result contains updated provider/model
      expect(result).toMatchObject({
        success: true,
        agentConfig: {
          aiProvider: 'google',
          aiModel: 'gemini-pro',
        },
      });

      // Assert - verify repository received correct update data
      expect(applyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'agent-1',
          updates: expect.objectContaining({
            aiProvider: 'google',
            aiModel: 'gemini-pro',
          }),
        })
      );
    });

    it('updates visibility and context settings', async () => {
      // Arrange
      const mockAgent = {
        id: 'agent-1',
        title: 'My Agent',
        type: 'AI_CHAT',
        driveId: 'drive-1',
        systemPrompt: null,
        enabledTools: null,
        aiProvider: null,
        aiModel: null,
        agentDefinition: null,
        visibleToGlobalAssistant: false,
        includeDrivePrompt: false,
        includePageTree: false,
        pageTreeScope: null,
        revision: 4,
      };
      mockAgentRepository.findById.mockResolvedValue(mockAgent);
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act
      const result = await agentTools.update_agent_config.execute!(
        {
          agentPath: '/drive/agent',
          agentId: 'agent-1',
          visibleToGlobalAssistant: true,
          includeDrivePrompt: true,
          includePageTree: true,
          pageTreeScope: 'drive',
        },
        context
      );

      // Assert
      expect(result).toMatchObject({
        success: true,
        updatedFields: expect.arrayContaining([
          'visibleToGlobalAssistant',
          'includeDrivePrompt',
          'includePageTree',
          'pageTreeScope',
        ]),
      });

      // Verify repository received correct update data
      expect(applyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'agent-1',
          updates: expect.objectContaining({
            visibleToGlobalAssistant: true,
            includeDrivePrompt: true,
            includePageTree: true,
            pageTreeScope: 'drive',
          }),
        })
      );
    });

    it('handles repository errors gracefully', async () => {
      // Arrange
      mockAgentRepository.findById.mockRejectedValue(new Error('Database connection failed'));

      const context = {
        toolCallId: '1',
        messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      // Act & Assert
      await expect(
        agentTools.update_agent_config.execute!(
          { agentPath: '/drive/agent', agentId: 'agent-1' },
          context
        )
      ).rejects.toThrow('Failed to update agent configuration');
    });
  });
});
