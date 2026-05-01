import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserEditPage: vi.fn(),
  canUserViewPage: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  },
}));

vi.mock('@/lib/workflows/task-trigger-helpers', () => ({
  createTaskTriggerWorkflow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastTaskEvent: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      taskItems: { findFirst: vi.fn() },
      taskLists: { findFirst: vi.fn() },
      pages: { findFirst: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ field, value })),
  and: vi.fn((...conditions) => conditions),
}));

vi.mock('@pagespace/db/schema/core', () => ({ pages: {} }));
vi.mock('@pagespace/db/schema/tasks', () => ({ taskItems: {}, taskLists: {} }));
vi.mock('@pagespace/db/schema/workflows', () => ({ workflows: { taskItemId: 't', triggerType: 'tt' } }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage, canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { createTaskTriggerWorkflow } from '@/lib/workflows/task-trigger-helpers';
import { GET, PUT } from '../route';
import { DELETE } from '../[triggerType]/route';

const userId = 'user-1';
const taskId = 'task-1';
const taskListId = 'tasklist-1';
const pageId = 'page-1';
const driveId = 'drive-1';
const agentPageId = 'agent-1';

const mkRequest = (method: string, body?: unknown) =>
  new Request(`https://example.com/api/tasks/${taskId}/triggers`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { 'content-type': 'application/json' } : undefined,
  });

const mkParams = (extra: Record<string, string> = {}) => Promise.resolve({ taskId, ...extra });

describe('Task triggers API', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isAuthError).mockImplementation(
      (r: unknown) => r != null && typeof r === 'object' && 'error' in r,
    );
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    } as never);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    } as never);
  });

  describe('GET /api/tasks/[taskId]/triggers', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
        error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      } as never);

      const res = await GET(mkRequest('GET'), { params: mkParams() });
      expect(res.status).toBe(401);
    });

    it('returns 404 when task does not exist', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
      vi.mocked(db.query.taskItems.findFirst).mockResolvedValue(undefined as never);

      const res = await GET(mkRequest('GET'), { params: mkParams() });
      expect(res.status).toBe(404);
    });

    it('returns 403 when user lacks view permission', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
      vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({ id: taskId, taskListId, dueDate: null, metadata: null } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: taskListId, pageId } as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: pageId, driveId, isTrashed: false } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const res = await GET(mkRequest('GET'), { params: mkParams() });
      expect(res.status).toBe(403);
    });

    it('returns triggers list on success', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
      vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({ id: taskId, taskListId, dueDate: null, metadata: null } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: taskListId, pageId } as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: pageId, driveId, isTrashed: false } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      const triggerRow = { id: 'wf-1', triggerType: 'task_completion', agentPageId, prompt: 'do it', isEnabled: true };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([triggerRow]) })),
      } as never);

      const res = await GET(mkRequest('GET'), { params: mkParams() });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.triggers).toHaveLength(1);
      expect(body.triggers[0].id).toBe('wf-1');
    });
  });

  describe('PUT /api/tasks/[taskId]/triggers', () => {
    it('returns 400 for invalid input', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);

      const res = await PUT(mkRequest('PUT', { triggerType: 'bogus' }), { params: mkParams() });
      expect(res.status).toBe(400);
    });

    it('returns 403 when user lacks edit permission', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
      vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({ id: taskId, taskListId, dueDate: null, metadata: null } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: taskListId, pageId } as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: pageId, driveId, isTrashed: false } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const res = await PUT(
        mkRequest('PUT', { triggerType: 'completion', agentPageId, prompt: 'go' }),
        { params: mkParams() },
      );
      expect(res.status).toBe(403);
    });

    it('rejects due_date trigger when task has no due date', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
      vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({ id: taskId, taskListId, dueDate: null, metadata: null } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: taskListId, pageId } as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: pageId, driveId, isTrashed: false } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);

      const res = await PUT(
        mkRequest('PUT', { triggerType: 'due_date', agentPageId, prompt: 'go' }),
        { params: mkParams() },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/due date/i);
    });

    it('upserts trigger and returns 200 on success', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
      vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({ id: taskId, taskListId, dueDate: null, metadata: null } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: taskListId, pageId } as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: pageId, driveId, isTrashed: false } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ id: 'wf-2', triggerType: 'task_completion' }]),
        })),
      } as never);

      const res = await PUT(
        mkRequest('PUT', { triggerType: 'completion', agentPageId, prompt: 'go' }),
        { params: mkParams() },
      );
      expect(res.status).toBe(200);
      expect(createTaskTriggerWorkflow).toHaveBeenCalledOnce();
    });
  });

  describe('DELETE /api/tasks/[taskId]/triggers/[triggerType]', () => {
    const mkDeleteParams = (triggerType: string) =>
      Promise.resolve({ taskId, triggerType });

    it('returns 400 for invalid trigger type', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);

      const res = await DELETE(mkRequest('DELETE'), { params: mkDeleteParams('bogus') });
      expect(res.status).toBe(400);
    });

    it('disables trigger and clears metadata triggerTypes', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
      vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({
        id: taskId,
        taskListId,
        metadata: { hasTrigger: true, triggerTypes: ['task_completion', 'task_due_date'] },
      } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: taskListId, pageId } as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: pageId, isTrashed: false } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);

      const res = await DELETE(mkRequest('DELETE'), { params: mkDeleteParams('completion') });
      expect(res.status).toBe(200);

      // db.update was called twice: once for workflows, once for taskItems metadata
      expect(db.update).toHaveBeenCalledTimes(2);
    });
  });
});
