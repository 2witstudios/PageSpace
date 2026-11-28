/**
 * Agent Signup Phase 2c — get_assigned_tasks returns the user co-assignee into
 * model context, so an AI agent ACCOUNT's name is labelled; a human's is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
    query: {
      taskItems: { findMany: vi.fn() },
      pages: { findFirst: vi.fn(), findMany: vi.fn() },
      taskLists: { findMany: vi.fn() },
      taskStatusConfigs: { findMany: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(), and: vi.fn(), desc: vi.fn(), asc: vi.fn(), isNull: vi.fn(), inArray: vi.fn(), sql: vi.fn(),
}));
vi.mock('../actor-permissions', () => ({
  canActorViewPage: vi.fn(async () => true),
  canActorAccessDrive: vi.fn(async () => true),
  canActorEditPage: vi.fn(async () => true),
}));
vi.mock('@/lib/tasks/decrypt-task-relations', () => ({
  decryptTaskUserRelations: vi.fn(async (rows: unknown[]) => rows),
}));
vi.mock('@/lib/websocket', () => ({
  broadcastTaskEvent: vi.fn(), broadcastPageEvent: vi.fn(), createPageEventPayload: vi.fn(),
}));
vi.mock('@/lib/workflows/task-trigger-helpers', () => ({
  createTaskTriggerWorkflow: vi.fn(), syncTaskDueDateTrigger: vi.fn(), cancelTaskDueDateTrigger: vi.fn(),
  fireCompletionTrigger: vi.fn(), disableTaskTriggers: vi.fn(),
}));

import { db } from '@pagespace/db/db';
import { taskManagementTools } from '../task-management-tools';
import type { ToolExecutionContext } from '../../core/types';

const task = (id: string, assignee: { id: string; name: string; accountType: 'human' | 'agent' }) => ({
  id, status: 'pending', priority: 'medium', startDate: null, dueDate: null, completedAt: null, pageId: `p-${id}`,
  page: { id: `p-${id}`, title: id, isTrashed: false, parentId: null, position: 0 },
  assignee,
});

describe('get_assigned_tasks — user co-assignee label', () => {
  beforeEach(() => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: 'agent-page', title: 'Bot', driveId: 'd1' } as never);
    vi.mocked(db.query.taskItems.findMany).mockResolvedValue([
      task('t1', { id: 'a1', name: 'Helper', accountType: 'agent' }),
      task('t2', { id: 'h1', name: '  Ada ', accountType: 'human' }),
    ] as never);
  });

  it('selects accountType, labels an agent account and leaves a human byte-identical', async () => {
    const result = await taskManagementTools.get_assigned_tasks.execute!(
      { agentId: 'agent-page', includeCompleted: false },
      { toolCallId: 'c', messages: [], experimental_context: { userId: 'u1' } as ToolExecutionContext },
    ) as { tasks: { userAssignee: { name: string; accountType: string } | null }[] };

    const query = vi.mocked(db.query.taskItems.findMany).mock.calls[0][0] as unknown as {
      with: { assignee: { columns: Record<string, boolean> } };
    };
    expect(query.with.assignee.columns.accountType).toBe(true);
    expect(result.tasks.map((t) => t.userAssignee?.name)).toEqual(['[AI agent account, self-named] "Helper"', '  Ada ']);
    expect(result.tasks.map((t) => t.userAssignee?.accountType)).toEqual(['agent', 'human']);
  });
});
