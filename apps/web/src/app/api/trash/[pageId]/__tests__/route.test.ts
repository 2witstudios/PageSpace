/**
 * Permanent page delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFindPage,
  mockTransaction,
  mockExecute,
  mockCanDelete,
  mockAuthenticate,
  mockReapOrphanedFiles,
  mockAuditRequest,
} = vi.hoisted(() => ({
  mockFindPage: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecute: vi.fn(),
  mockCanDelete: vi.fn(),
  mockAuthenticate: vi.fn(),
  mockReapOrphanedFiles: vi.fn(),
  mockAuditRequest: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { pages: { findFirst: (...args: unknown[]) => mockFindPage(...args) } },
    execute: (...args: unknown[]) => mockExecute(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: {}, favorites: {},
}));
vi.mock('@pagespace/db/schema/members', () => ({ pagePermissions: {} }));
vi.mock('@pagespace/db/schema/chat', () => ({ channelMessages: {} }));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticate(...args),
  isAuthError: (value: unknown) => typeof value === 'object' && value !== null && 'error' in value,
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserDeletePage: (...args: unknown[]) => mockCanDelete(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: (...args: unknown[]) => mockAuditRequest(...args) }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(async () => ({ actorEmail: 'a@x.test', actorDisplayName: 'A' })),
  logPageActivity: vi.fn(),
}));
vi.mock('@/lib/storage/reap-orphaned-files', () => ({
  reapOrphanedFiles: (...args: unknown[]) => mockReapOrphanedFiles(...args),
}));
vi.mock('next/server', () => ({
  NextResponse: Object.assign(
    function NextResponse(body: string, init?: ResponseInit) {
      return new Response(body, init);
    },
    {
      json: (body: unknown, init?: ResponseInit) =>
        new Response(JSON.stringify(body), { status: init?.status ?? 200 }),
    },
  ),
}));

import { DELETE } from '../route';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/trash/page-1', { method: 'DELETE' });
}

const params = Promise.resolve({ pageId: 'page-1' });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ userId: 'user-1' });
  mockCanDelete.mockResolvedValue(true);
  mockFindPage.mockResolvedValue({ id: 'page-1', title: 'Folder', driveId: 'drive-1', isTrashed: true });
  mockExecute.mockResolvedValue({ rows: [] });
  mockTransaction.mockImplementation(async () => {});
  mockReapOrphanedFiles.mockResolvedValue({ dbRecordsDeleted: 0 });
});

describe('DELETE /api/trash/[pageId]', () => {
  it('given an authenticated, authorized delete of a trashed page, should permanently delete it', async () => {
    const response = await DELETE(makeRequest(), { params });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBe('Page permanently deleted.');
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.delete', userId: 'user-1', resourceType: 'page', resourceId: 'page-1' }),
    );
  });

  it('given no access, should return 403 and never delete', async () => {
    mockCanDelete.mockResolvedValue(false);

    const response = await DELETE(makeRequest(), { params });

    expect(response.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('given a page that is not in the trash, should reject with 400 and never delete', async () => {
    mockFindPage.mockResolvedValue({ id: 'page-1', isTrashed: false, driveId: 'drive-1' });

    const response = await DELETE(makeRequest(), { params });

    expect(response.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('given orphaned files left by the delete, should reap them inline and log the count', async () => {
    mockExecute.mockResolvedValue({ rows: [{ id: 'file-1' }] });
    mockReapOrphanedFiles.mockResolvedValue({ dbRecordsDeleted: 1 });

    const response = await DELETE(makeRequest(), { params });

    expect(response.status).toBe(200);
    expect(mockReapOrphanedFiles).toHaveBeenCalledWith(expect.anything(), { fileIds: ['file-1'] });
  });

  it('given the inline reap fails, should still report success (the weekly cron retries)', async () => {
    mockExecute.mockResolvedValue({ rows: [{ id: 'file-1' }] });
    mockReapOrphanedFiles.mockRejectedValue(new Error('processor down'));

    const response = await DELETE(makeRequest(), { params });

    expect(response.status).toBe(200);
  });
});
