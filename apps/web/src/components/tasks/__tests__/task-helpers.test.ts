import { describe, it, expect } from 'vitest';
import { getAssigneeText } from '../task-helpers';
import type { Task } from '../types';

const task = (overrides: Partial<Task>): Task => ({
  id: 't', userId: 'u', assigneeId: null, assigneeAgentId: null, pageId: null, title: 'T',
  status: 'pending', priority: 'medium', position: 0, dueDate: null, completedAt: null,
  createdAt: '', updatedAt: '', assignee: null, assigneeAgent: null, user: null, page: null,
  ...overrides,
});

describe('getAssigneeText (Agent Signup 2c)', () => {
  it('leaves a human assignee name byte-identical', () => {
    expect(getAssigneeText(task({ assignee: { id: 'h', name: '  Ada ', image: null, accountType: 'human' } }))).toBe('  Ada ');
    expect(getAssigneeText(task({ assignee: { id: 'h', name: 'Ada', image: null } }))).toBe('Ada');
  });

  it('marks an AI agent account assignee in plain text', () => {
    expect(getAssigneeText(task({ assignee: { id: 'a', name: 'Helper', image: null, accountType: 'agent' } }))).toBe('Helper (AI agent)');
  });

  it('marks only the agent account among multiple assignees, and leaves AI agent pages unmarked', () => {
    expect(getAssigneeText(task({
      assignees: [
        { id: '1', taskId: 't', userId: 'h', agentPageId: null, user: { id: 'h', name: 'Ada', image: null, accountType: 'human' } },
        { id: '2', taskId: 't', userId: 'a', agentPageId: null, user: { id: 'a', name: 'Helper', image: null, accountType: 'agent' } },
        { id: '3', taskId: 't', userId: null, agentPageId: 'p', agentPage: { id: 'p', title: 'Research', type: 'AI_CHAT' } },
      ],
    }))).toBe('Ada, Helper (AI agent), Research');
  });

  it('falls back to the AI agent page title, then null', () => {
    expect(getAssigneeText(task({ assigneeAgent: { id: 'p', title: 'Research', type: 'AI_CHAT' } }))).toBe('Research');
    expect(getAssigneeText(task({}))).toBeNull();
  });
});
