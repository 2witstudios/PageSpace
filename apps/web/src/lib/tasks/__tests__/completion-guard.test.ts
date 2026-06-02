import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a: unknown, _b: unknown) => ({ eq: [_a, _b] })),
  and: vi.fn((...c: unknown[]) => ({ and: c })),
}));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id', parentId: 'parentId', isTrashed: 'isTrashed' } }));
vi.mock('@pagespace/db/schema/tasks', () => ({ taskItems: { completedAt: 'completedAt', pageId: 'pageId' } }));

import {
  assertSubTasksComplete,
  SubtasksIncompleteError,
  checkSubTasksComplete,
  toBlockedPayload,
  toToolFailure,
} from '../completion-guard';
import { db } from '@pagespace/db/db';

function mockSubTasks(rows: Array<{ completedAt: Date | null }>) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as never);
}

describe('assertSubTasksComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves without error when there are no sub-tasks', async () => {
    mockSubTasks([]);
    await expect(assertSubTasksComplete('task-page-1')).resolves.toBeUndefined();
  });

  it('resolves without error when all sub-tasks are complete', async () => {
    mockSubTasks([
      { completedAt: new Date('2024-01-01') },
      { completedAt: new Date('2024-01-02') },
    ]);
    await expect(assertSubTasksComplete('task-page-1')).resolves.toBeUndefined();
  });

  it('throws SubtasksIncompleteError when one sub-task is incomplete', async () => {
    mockSubTasks([
      { completedAt: new Date('2024-01-01') },
      { completedAt: null },
    ]);
    await expect(assertSubTasksComplete('task-page-1')).rejects.toThrow(SubtasksIncompleteError);
  });

  it('reports correct pending and total counts', async () => {
    mockSubTasks([
      { completedAt: new Date() },
      { completedAt: null },
      { completedAt: null },
    ]);
    const error = await assertSubTasksComplete('task-page-1').catch(e => e);
    expect(error).toBeInstanceOf(SubtasksIncompleteError);
    expect(error.pending).toBe(2);
    expect(error.total).toBe(3);
  });

  it('throws with all sub-tasks incomplete', async () => {
    mockSubTasks([{ completedAt: null }, { completedAt: null }]);
    const error = await assertSubTasksComplete('task-page-1').catch(e => e);
    expect(error).toBeInstanceOf(SubtasksIncompleteError);
    expect(error.pending).toBe(2);
    expect(error.total).toBe(2);
  });
});

describe('checkSubTasksComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when all sub-tasks are complete', async () => {
    mockSubTasks([{ completedAt: new Date() }]);
    await expect(checkSubTasksComplete('task-page-1')).resolves.toBeNull();
  });

  it('returns null when there are no sub-tasks', async () => {
    mockSubTasks([]);
    await expect(checkSubTasksComplete('task-page-1')).resolves.toBeNull();
  });

  it('returns the canonical blocked payload when a sub-task is incomplete', async () => {
    mockSubTasks([{ completedAt: new Date() }, { completedAt: null }]);
    await expect(checkSubTasksComplete('task-page-1')).resolves.toEqual({
      code: 'SUBTASKS_INCOMPLETE',
      error: 'Complete all sub-tasks first (1 of 2 remaining)',
      pending: 1,
      total: 2,
    });
  });
});

describe('toBlockedPayload / toToolFailure', () => {
  it('toBlockedPayload maps the error into the canonical payload', () => {
    expect(toBlockedPayload(new SubtasksIncompleteError(2, 3))).toEqual({
      code: 'SUBTASKS_INCOMPLETE',
      error: 'Complete all sub-tasks first (2 of 3 remaining)',
      pending: 2,
      total: 3,
    });
  });

  it('toToolFailure wraps the payload as an AI-tool failure result', () => {
    const payload = { code: 'SUBTASKS_INCOMPLETE' as const, error: 'x', pending: 1, total: 2 };
    expect(toToolFailure(payload)).toEqual({ success: false, ...payload });
  });
});

describe('SubtasksIncompleteError', () => {
  it('has correct code, pending, total, and message', () => {
    const err = new SubtasksIncompleteError(3, 5);
    expect(err.code).toBe('SUBTASKS_INCOMPLETE');
    expect(err.pending).toBe(3);
    expect(err.total).toBe(5);
    expect(err.message).toContain('3');
    expect(err.message).toContain('5');
    expect(err.name).toBe('SubtasksIncompleteError');
    expect(err).toBeInstanceOf(Error);
  });
});
