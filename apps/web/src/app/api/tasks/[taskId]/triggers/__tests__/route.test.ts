import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserEditPage: vi.fn(),
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
  inArray: vi.fn((col, values) => ({ type: 'inArray', col, values })),
}));

vi.mock('@pagespace/db/schema/core', () => ({ pages: {} }));
vi.mock('@pagespace/db/schema/tasks', () => ({ taskItems: {}, taskLists: {} }));
vi.mock('@pagespace/db/schema/workflows', () => ({ workflows: { taskItemId: 't', triggerType: 'tt' } }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
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

    it('returns 403 when user lacks edit permission (trigger configs are editor-only)', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
      vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({ id: taskId, taskListId, dueDate: null, metadata: null } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: taskListId, pageId } as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: pageId, driveId, isTrashed: false } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const res = await GET(mkRequest('GET'), { params: mkParams() });
      expect(res.status).toBe(403);
    });

    it('returns triggers list on success', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
      vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({ id: taskId, taskListId, dueDate: null, metadata: null } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: taskListId, pageId } as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: pageId, driveId, isTrashed: false } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
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

    it('returns 500 if the trigger row is missing after upsert', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
      vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({ id: taskId, taskListId, dueDate: null, metadata: null } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: taskListId, pageId } as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: pageId, driveId, isTrashed: false } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      // Simulate the post-upsert re-query coming back empty (race / constraint loss)
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
      } as never);

      const res = await PUT(
        mkRequest('PUT', { triggerType: 'completion', agentPageId, prompt: 'go' }),
        { params: mkParams() },
      );
      expect(res.status).toBe(500);
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

    it('disables trigger and recomputes metadata from the workflows table', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
      vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({
        id: taskId,
        taskListId,
        // Stale metadata: claims both triggers active even though completion is being removed
        metadata: { hasTrigger: true, triggerTypes: ['task_completion', 'task_due_date'] },
      } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: taskListId, pageId } as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: pageId, isTrashed: false } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);

      // Live workflows query returns only the due_date trigger (the completion one was just disabled)
      const setCalls: Record<string, unknown>[] = [];
      const setSpy = vi.fn((args) => {
        setCalls.push(args);
        return { where: vi.fn().mockResolvedValue(undefined) };
      });
      vi.mocked(db.update).mockReturnValue({ set: setSpy } as never);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ triggerType: 'task_due_date' }]),
        })),
      } as never);

      const res = await DELETE(mkRequest('DELETE'), { params: mkDeleteParams('completion') });
      expect(res.status).toBe(200);

      // db.update was called twice: once for workflows, once for taskItems metadata
      expect(db.update).toHaveBeenCalledTimes(2);

      // Metadata write should reflect the live workflows table, not the stale task.metadata
      const metadataWrite = setCalls.find((c) => c.metadata !== undefined);
      const meta = metadataWrite?.metadata as { triggerTypes?: string[]; hasTrigger?: boolean };
      expect(meta?.triggerTypes).toEqual(['task_due_date']);
      expect(meta?.hasTrigger).toBe(true);
    });

    it('marks hasTrigger=false when removing the last trigger', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as never);
      vi.mocked(db.query.taskItems.findFirst).mockResolvedValue({
        id: taskId,
        taskListId,
        metadata: { hasTrigger: true, triggerTypes: ['task_completion'] },
      } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: taskListId, pageId } as never);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: pageId, isTrashed: false } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);

      const setCalls: Record<string, unknown>[] = [];
      const setSpy = vi.fn((args) => {
        setCalls.push(args);
        return { where: vi.fn().mockResolvedValue(undefined) };
      });
      vi.mocked(db.update).mockReturnValue({ set: setSpy } as never);
      // No remaining triggers
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
      } as never);

      const res = await DELETE(mkRequest('DELETE'), { params: mkDeleteParams('completion') });
      expect(res.status).toBe(200);

      const metadataWrite = setCalls.find((c) => c.metadata !== undefined);
      const meta = metadataWrite?.metadata as { triggerTypes?: string[]; hasTrigger?: boolean };
      expect(meta?.triggerTypes).toEqual([]);
      expect(meta?.hasTrigger).toBe(false);
    });
  });
});
