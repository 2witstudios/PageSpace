/**
 * Tests for /api/user/favorites/reorder
 * Verifies auditRequest is called for PATCH, and that reordering is delegated
 * to the shared locked-batch-reorder primitive as a single batched write
 * instead of N sequential per-row updates (the deadlock-prone pattern fixed
 * in Phase 3 of the task board crash-prevention epic, j44e35jwzlhr54fbmruk3k4i).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

const { mockTransaction } = vi.hoisted(() => ({
  mockTransaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    await fn({});
  }),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      favorites: {
        findMany: vi.fn().mockResolvedValue([{ id: 'fav-1' }, { id: 'fav-2' }, { id: 'fav-3' }]),
      },
    },
    transaction: mockTransaction,
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ op: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ op: 'inArray', a, b })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  favorites: { id: 'id', userId: 'userId', position: 'position' },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

const { mockLockedBatchReorder } = vi.hoisted(() => ({
  mockLockedBatchReorder: vi.fn().mockResolvedValue(['fav-1', 'fav-2', 'fav-3']),
}));
vi.mock('@pagespace/lib/services/reorder', () => ({
  computeReorderPlan: vi.fn((entries: { id: string; position: number }[]) => {
    const positionById = new Map(entries.map((e) => [e.id, e.position]));
    return { orderedIds: Array.from(positionById.keys()).sort(), positionById };
  }),
  lockedBatchReorder: mockLockedBatchReorder,
}));

import { PATCH } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { favorites } from '@pagespace/db/schema/core';

const mockUserId = 'user_123';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

function createRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/user/favorites/reorder', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/user/favorites/reorder audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs write audit event with reorder action', async () => {
    const request = createRequest({ orderedIds: ['fav-1', 'fav-2'] });

    await PATCH(request);

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.write', userId: mockUserId, resourceType: 'favorites', resourceId: 'self', details: { action: 'reorder' } }
    );
  });
});

describe('PATCH /api/user/favorites/reorder locked-batch reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('issues one batched lockedBatchReorder call instead of N sequential updates', async () => {
    const orderedIds = ['fav-1', 'fav-2', 'fav-3'];
    const response = await PATCH(createRequest({ orderedIds }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockLockedBatchReorder).toHaveBeenCalledTimes(1);

    const [, opts] = mockLockedBatchReorder.mock.calls[0];
    expect(opts.table).toBe(favorites);
    expect(opts.idColumn).toBe(favorites.id);
    expect(opts.positionColumn).toBe(favorites.position);
    expect(opts.plan.orderedIds.slice().sort()).toEqual(orderedIds.slice().sort());
    expect(opts.touchColumns).toBeUndefined();
  });

  it('scopes the reorder to the authenticated user', async () => {
    await PATCH(createRequest({ orderedIds: ['fav-1', 'fav-2'] }));

    const [, opts] = mockLockedBatchReorder.mock.calls[0];
    expect(opts.scopeWhere).toEqual({ op: 'eq', a: favorites.userId, b: mockUserId });
  });

  it('is a no-op and skips the transaction when orderedIds is empty', async () => {
    const response = await PATCH(createRequest({ orderedIds: [] }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockLockedBatchReorder).not.toHaveBeenCalled();
  });

  it('returns 400 when orderedIds is not an array', async () => {
    const response = await PATCH(createRequest({ orderedIds: 'not-an-array' }));
    expect(response.status).toBe(400);
    expect(mockLockedBatchReorder).not.toHaveBeenCalled();
  });

  it('returns 403 and skips the reorder when a submitted id does not belong to the user', async () => {
    const response = await PATCH(createRequest({ orderedIds: ['fav-1', 'not-mine'] }));
    expect(response.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockLockedBatchReorder).not.toHaveBeenCalled();
  });
});
