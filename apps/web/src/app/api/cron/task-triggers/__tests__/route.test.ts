import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract tests for /api/cron/task-triggers
// ============================================================================

const {
  mockReturning,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
  mockOrderBy,
  mockLimit,
} = vi.hoisted(() => ({
  mockReturning: vi.fn().mockResolvedValue([]),
  mockUpdateWhere: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdate: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockSelect: vi.fn(),
  mockOrderBy: vi.fn(),
  mockLimit: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@/lib/workflows/workflow-executor', () => ({
  executeWorkflow: vi.fn(),
}));

const mockAudit = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
    },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: mockAudit,
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ op: 'eq', field, value })),
  and: vi.fn((...conds) => ({ op: 'and', conds })),
  lte: vi.fn((field, value) => ({ op: 'lte', field, value })),
  inArray: vi.fn((field, values) => ({ op: 'inArray', field, values })),
  isNull: vi.fn((field) => ({ op: 'isNull', field })),
  asc: vi.fn((field) => field),
}));
vi.mock('@pagespace/db/schema/workflows', () => ({
  workflows: {
    id: 'id',
  },
}));
vi.mock('@pagespace/db/schema/task-triggers', () => ({
  taskTriggers: {
    id: 'id',
    workflowId: 'workflowId',
    taskItemId: 'taskItemId',
    triggerType: 'triggerType',
    isEnabled: 'isEnabled',
    nextRunAt: 'nextRunAt',
    lastFiredAt: 'lastFiredAt',
    lastFireError: 'lastFireError',
  },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { id: 'id', completedAt: 'completedAt', dueDate: 'dueDate' },
}));

import { POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeWorkflow } from '@/lib/workflows/workflow-executor';
import { isNull } from '@pagespace/db/operators';

// ============================================================================
// Fixtures
// ============================================================================

const MOCK_TRIGGER = {
  id: 'trg_1',
  workflowId: 'wf_1',
  taskItemId: 'task_1',
  triggerType: 'due_date' as const,
  nextRunAt: new Date('2025-01-01T09:00:00Z'),
  lastFiredAt: null,
  lastFireError: null,
  isEnabled: true,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const MOCK_WORKFLOW = {
  id: 'wf_1',
  driveId: 'drive_1',
  createdBy: 'user_1',
  name: 'task-trigger-due_date-task_1',
  agentPageId: 'agent_1',
  prompt: 'Do the thing',
  contextPageIds: [],
  triggerType: 'cron',
  cronExpression: null,
  timezone: 'UTC',
  instructionPageId: null,
  isEnabled: true,
};

const MOCK_TASK = {
  id: 'task_1',
  completedAt: null,
  dueDate: new Date('2025-01-01T09:00:00Z'),
};

// The route's select chains have two shapes:
//   A) due-trigger discovery: select().from(taskTriggers).where(...).orderBy(...).limit(N)
//   B) row lookups:           select().from(workflows|taskItems).where(...)
// We support both by making `where` return a thenable that ALSO carries
// an `.orderBy().limit()` chain. When awaited it resolves to the lookup
// row array; when chained it resolves to the discovery row array.
//
// Test fixtures push results onto two FIFO queues:
//   discoveryQueue: each element is the rows the next .limit() call returns
//   lookupQueue:    each element is the rows the next awaited .where(...) returns
const discoveryQueue: unknown[][] = [];
const lookupQueue: unknown[][] = [];

function pushDiscoveryRows(rows: unknown[]) { discoveryQueue.push(rows); }
function pushLookupRows(rows: unknown[]) { lookupQueue.push(rows); }

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/cron/task-triggers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);

    discoveryQueue.length = 0;
    lookupQueue.length = 0;

    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    // Lazy thenable: only pop the lookup queue when actually awaited.
    // Plain `Promise.resolve(...)` would pop eagerly when where() is called,
    // and the discovery `.where().orderBy().limit()` chain (which never
    // awaits the where return) would silently consume a lookup row.
    mockSelectWhere.mockImplementation(() => ({
      then(onFulfilled: (rows: unknown[]) => void) {
        const lookupRows = lookupQueue.shift() ?? [];
        onFulfilled(lookupRows);
      },
      orderBy: mockOrderBy,
    }));
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockLimit.mockImplementation(() => Promise.resolve(discoveryQueue.shift() ?? []));

    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockImplementation(() => {
      const p = Promise.resolve(undefined) as Promise<undefined> & { returning: typeof mockReturning };
      p.returning = mockReturning;
      return p;
    });
    mockReturning.mockResolvedValue([]);
  });

  it('returns auth error when cron request is invalid', async () => {
    const errorResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(errorResponse);

    const request = new Request('https://example.com/api/cron/task-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it('returns success with 0 executed when no triggers are due', async () => {
    pushDiscoveryRows([]);

    const request = new Request('https://example.com/api/cron/task-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(0);
    expect(body.message).toBe('No task triggers due');
  });

  it('atomically claims due triggers with a lastFiredAt IS NULL guard', async () => {
    pushDiscoveryRows([MOCK_TRIGGER]);
    mockReturning.mockResolvedValueOnce([MOCK_TRIGGER]);
    pushLookupRows([MOCK_WORKFLOW]); // workflow lookup
    pushLookupRows([MOCK_TASK]);     // task lookup
    vi.mocked(executeWorkflow).mockResolvedValue({ success: true, durationMs: 50 });

    const request = new Request('https://example.com/api/cron/task-triggers', { method: 'POST' });
    await POST(request);

    // The claim WHERE must include isNull(taskTriggers.lastFiredAt)
    const guardedFields = vi.mocked(isNull).mock.calls.map((c) => c[0]);
    expect(guardedFields).toContain('lastFiredAt');
  });

  it('skips firing when the linked task is completed', async () => {
    pushDiscoveryRows([MOCK_TRIGGER]);
    mockReturning.mockResolvedValueOnce([MOCK_TRIGGER]);
    pushLookupRows([MOCK_WORKFLOW]);
    pushLookupRows([{ ...MOCK_TASK, completedAt: new Date() }]);

    const request = new Request('https://example.com/api/cron/task-triggers', { method: 'POST' });
    await POST(request);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('skips firing when the linked task has no due date (was cleared)', async () => {
    pushDiscoveryRows([MOCK_TRIGGER]);
    mockReturning.mockResolvedValueOnce([MOCK_TRIGGER]);
    pushLookupRows([MOCK_WORKFLOW]);
    pushLookupRows([{ ...MOCK_TASK, dueDate: null }]);

    const request = new Request('https://example.com/api/cron/task-triggers', { method: 'POST' });
    await POST(request);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('skips firing when the linked task due date was postponed past now', async () => {
    pushDiscoveryRows([MOCK_TRIGGER]);
    mockReturning.mockResolvedValueOnce([MOCK_TRIGGER]);
    pushLookupRows([MOCK_WORKFLOW]);
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24);
    pushLookupRows([{ ...MOCK_TASK, dueDate: future }]);

    const request = new Request('https://example.com/api/cron/task-triggers', { method: 'POST' });
    await POST(request);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('marks trigger as disabled with error when linked workflow is missing', async () => {
    pushDiscoveryRows([MOCK_TRIGGER]);
    mockReturning.mockResolvedValueOnce([MOCK_TRIGGER]);
    pushLookupRows([]);             // workflow lookup empty
    pushLookupRows([MOCK_TASK]);    // task lookup (batch-loaded regardless)

    const request = new Request('https://example.com/api/cron/task-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(executeWorkflow).not.toHaveBeenCalled();
    const setArgs = mockUpdateSet.mock.calls.map((c) => c[0]);
    const found = setArgs.find((arg) =>
      typeof arg === 'object' && arg !== null && 'lastFireError' in arg
        && (arg as { lastFireError?: string }).lastFireError === 'Linked workflow not found',
    );
    expect(found).toBeDefined();
  });

  it('successfully fires an eligible due trigger and composes WorkflowExecutionInput with taskContext', async () => {
    pushDiscoveryRows([MOCK_TRIGGER]);
    mockReturning.mockResolvedValueOnce([MOCK_TRIGGER]);
    pushLookupRows([MOCK_WORKFLOW]);
    pushLookupRows([MOCK_TASK]);
    vi.mocked(executeWorkflow).mockResolvedValue({ success: true, durationMs: 100 });

    const request = new Request('https://example.com/api/cron/task-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(1);
    expect(executeWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: MOCK_WORKFLOW.id,
      agentPageId: MOCK_WORKFLOW.agentPageId,
      prompt: MOCK_WORKFLOW.prompt,
      taskContext: { taskItemId: MOCK_TRIGGER.taskItemId, triggerType: MOCK_TRIGGER.triggerType },
    }));
  });

  it('disables the trigger after firing (one-shot semantics)', async () => {
    pushDiscoveryRows([MOCK_TRIGGER]);
    mockReturning.mockResolvedValueOnce([MOCK_TRIGGER]);
    pushLookupRows([MOCK_WORKFLOW]);
    pushLookupRows([MOCK_TASK]);
    vi.mocked(executeWorkflow).mockResolvedValue({ success: true, durationMs: 50 });

    const request = new Request('https://example.com/api/cron/task-triggers', { method: 'POST' });
    await POST(request);

    const setArgs = mockUpdateSet.mock.calls.map((c) => c[0]);
    const disablingCall = setArgs.find((arg) =>
      typeof arg === 'object' && arg !== null && 'isEnabled' in arg
        && (arg as { isEnabled?: boolean }).isEnabled === false,
    );
    expect(disablingCall).toBeDefined();
  });
});
