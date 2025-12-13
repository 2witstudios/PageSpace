import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AISelector } from '../AISelector';
import type { AgentSummary } from '@/hooks/page-agents';
import type { AgentInfo } from '@/stores/page-agents';

// Mock the usePageAgents hook
vi.mock('@/hooks/page-agents', () => ({
  usePageAgents: vi.fn(),
}));

import { usePageAgents } from '@/hooks/page-agents';

describe('AISelector', () => {
  const mockOnSelectAgent = vi.fn();

  const mockAgentsByDrive = [
    {
      driveId: 'drive_123',
      driveName: 'My Workspace',
      driveSlug: 'my-workspace',
      agentCount: 1,
      agents: [
        {
          id: 'agent_456',
          title: 'Test Agent',
          parentId: 'root',
          position: 0,
          aiProvider: 'openai',
          aiModel: 'gpt-4',
          hasWelcomeMessage: false,
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
          driveId: 'drive_123',
          driveName: 'My Workspace',
          driveSlug: 'my-workspace',
          hasSystemPrompt: false,
        },
      ],
    },
  ];

  const mockToAgentInfo = (agent: AgentSummary): AgentInfo => ({
    id: agent.id,
    title: agent.title || 'Unnamed Agent',
    driveId: agent.driveId,
    driveName: agent.driveName,
    aiProvider: agent.aiProvider,
    aiModel: agent.aiModel,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock: return agents
    vi.mocked(usePageAgents).mockReturnValue({
      agentsByDrive: mockAgentsByDrive,
      allAgents: mockAgentsByDrive[0].agents,
      totalCount: 1,
      driveCount: 1,
      isLoading: false,
      isError: false,
      error: undefined,
      mutate: vi.fn(),
      toAgentInfo: mockToAgentInfo,
    });
  });

  it('should render Global Assistant when no agent selected', () => {
    render(
      <AISelector
        selectedAgent={null}
        onSelectAgent={mockOnSelectAgent}
      />
    );

    expect(screen.getByText('Global Assistant')).toBeInTheDocument();
  });

  it('should render agent name when agent selected', () => {
    const selectedAgent = {
      id: 'agent_456',
      title: 'Test Agent',
      driveId: 'drive_123',
      driveName: 'My Workspace',
    };

    render(
      <AISelector
        selectedAgent={selectedAgent}
        onSelectAgent={mockOnSelectAgent}
      />
    );

    expect(screen.getByText('Test Agent')).toBeInTheDocument();
  });

  it('should call onSelectAgent when agent clicked', async () => {
    const user = userEvent.setup();

    render(
      <AISelector
        selectedAgent={null}
        onSelectAgent={mockOnSelectAgent}
      />
    );

    // Open dropdown
    await user.click(screen.getByRole('button'));

    // Click on the agent
    await user.click(screen.getByText('Test Agent'));

    expect(mockOnSelectAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent_456',
        title: 'Test Agent',
      })
    );
  });
});
