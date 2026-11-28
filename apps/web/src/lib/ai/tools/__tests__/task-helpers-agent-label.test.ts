/**
 * Agent Signup Phase 2c — task tool output enters model context, so an AI
 * agent ACCOUNT assignee's self-chosen name is labelled; a human's is unchanged.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => 'subquery') })) })),
    query: { taskItems: { findMany: vi.fn() } },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(), and: vi.fn(), inArray: vi.fn(), desc: vi.fn(), asc: vi.fn(), isNull: vi.fn(), sql: vi.fn(),
}));
vi.mock('@/lib/tasks/decrypt-task-relations', () => ({
  decryptTaskUserRelations: vi.fn(async (rows: unknown[]) => rows),
}));

import { db } from '@pagespace/db/db';
import { fetchEnrichedTasks, serializeTaskItem } from '../task-helpers';

const row = {
  id: 't1', status: 'pending', priority: 'medium', assigneeId: 'a1', assigneeAgentId: null,
  startDate: null, dueDate: null, completedAt: null, pageId: 'p1',
  page: { title: 'Task', content: '', position: 0 },
  assignee: { id: 'a1', name: 'Helper', image: null, accountType: 'agent' as const },
  assigneeAgent: null,
  assignees: [
    { userId: 'a1', agentPageId: null, user: { id: 'a1', name: 'Helper', accountType: 'agent' as const }, agentPage: null },
    { userId: 'h1', agentPageId: null, user: { id: 'h1', name: '  Ada ', accountType: 'human' as const }, agentPage: null },
  ],
};

describe('fetchEnrichedTasks / serializeTaskItem — agent label', () => {
  it('selects accountType for the assignee and every assignees[].user', async () => {
    vi.mocked(db.query.taskItems.findMany).mockResolvedValue([] as never);
    await fetchEnrichedTasks('parent');
    const query = vi.mocked(db.query.taskItems.findMany).mock.calls[0][0] as unknown as {
      with: { assignee: { columns: Record<string, boolean> }; assignees: { with: { user: { columns: Record<string, boolean> } } } };
    };
    expect(query.with.assignee.columns.accountType).toBe(true);
    expect(query.with.assignees.with.user.columns.accountType).toBe(true);
  });

  it('labels an agent account assignee for the model and leaves a human byte-identical', () => {
    const out = serializeTaskItem(row as unknown as Parameters<typeof serializeTaskItem>[0]);
    expect(out.assignee).toEqual({ id: 'a1', name: '[AI agent account, self-named] "Helper"', image: null, accountType: 'agent' });
    expect(out.assignees.map((a) => a.user?.name)).toEqual(['[AI agent account, self-named] "Helper"', '  Ada ']);
    expect(out.assignees[1].user?.accountType).toBe('human');
  });
});
