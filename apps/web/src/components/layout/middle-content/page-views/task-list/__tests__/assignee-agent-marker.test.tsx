/**
 * Agent Signup Phase 2c — task assignee surfaces mark an AI agent account
 * beside its self-chosen name, from accountType; a human renders unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const swrState = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('swr', () => ({ default: vi.fn(() => ({ data: swrState.data })) }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));

import { AssigneeSelect } from '../AssigneeSelect';
import { MultiAssigneeSelect } from '../MultiAssigneeSelect';
import { TaskAssigneeLabel } from '../TaskAssigneeLabel';

const agentMember = { id: 'a1', type: 'user' as const, name: 'Helper', image: null, accountType: 'agent' };
const humanMember = { id: 'h1', type: 'user' as const, name: 'Ada', image: null, accountType: 'human' };

beforeEach(() => {
  swrState.data = { assignees: [humanMember, agentMember] };
});

describe('AssigneeSelect — agent marker', () => {
  it('marks the current assignee when it is an agent account', () => {
    render(<AssigneeSelect driveId="d" currentAssignee={{ id: 'a1', name: 'Helper', image: null, accountType: 'agent' }} onSelect={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Helper');
    expect(screen.getByLabelText('AI agent account')).toBeInTheDocument();
  });

  it('renders no marker for a human current assignee', () => {
    render(<AssigneeSelect driveId="d" currentAssignee={{ id: 'h1', name: 'Ada', image: null, accountType: 'human' }} onSelect={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Ada');
    expect(screen.queryByLabelText('AI agent account')).toBeNull();
  });

  it('marks only the agent account in the member list', () => {
    swrState.data = { assignees: [humanMember, agentMember] };
    render(<AssigneeSelect driveId="d" currentAssignee={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox'));
    const markers = screen.getAllByLabelText('AI agent account');
    expect(markers).toHaveLength(1);
    expect(markers[0].closest('[cmdk-item]')).toHaveTextContent('Helper');
  });
});

describe('MultiAssigneeSelect — agent marker', () => {
  const assignee = (userId: string, name: string, accountType: string) => ({
    id: `ta-${userId}`, taskId: 't', userId, agentPageId: null,
    user: { id: userId, name, image: null, accountType },
  });

  it('marks a lone agent-account assignee in the trigger', () => {
    swrState.data = { assignees: [] };
    render(<MultiAssigneeSelect driveId="d" assignees={[assignee('a1', 'Helper', 'agent')]} onUpdate={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Helper');
    expect(screen.getByLabelText('AI agent account')).toBeInTheDocument();
  });

  it('renders no marker for a human assignee', () => {
    swrState.data = { assignees: [] };
    render(<MultiAssigneeSelect driveId="d" assignees={[assignee('h1', 'Ada', 'human')]} onUpdate={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Ada');
    expect(screen.queryByLabelText('AI agent account')).toBeNull();
  });

  it('marks only the agent account in the member list', () => {
    render(<MultiAssigneeSelect driveId="d" assignees={[]} onUpdate={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox'));
    const markers = screen.getAllByLabelText('AI agent account');
    expect(markers).toHaveLength(1);
    expect(markers[0].closest('[cmdk-item]')).toHaveTextContent('Helper');
  });
});

describe('TaskAssigneeLabel (kanban card) — agent marker', () => {
  it('marks an agent-account assignee', () => {
    render(<TaskAssigneeLabel task={{ assignee: { id: 'a1', name: 'Helper', image: null, accountType: 'agent' }, assigneeAgent: null }} />);
    expect(screen.getByText('Helper')).toBeInTheDocument();
    expect(screen.getByLabelText('AI agent account')).toBeInTheDocument();
  });

  it('renders a human assignee unchanged, with no marker', () => {
    const { container } = render(<TaskAssigneeLabel task={{ assignee: { id: 'h1', name: 'Ada', image: null, accountType: 'human' }, assigneeAgent: null }} />);
    expect(container.innerHTML).toBe('<span class="text-xs text-muted-foreground">Ada</span>');
  });

  it('shows an AI agent page title unmarked, and nothing when unassigned', () => {
    render(<TaskAssigneeLabel task={{ assignee: null, assigneeAgent: { id: 'p', title: 'Research', type: 'AI_CHAT' } }} />);
    expect(screen.getByText('Research')).toBeInTheDocument();
    expect(screen.queryByLabelText('AI agent account')).toBeNull();
    const { container } = render(<TaskAssigneeLabel task={{ assignee: null, assigneeAgent: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
