import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isDriveOwnerOrAdmin: vi.fn(),
}));
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      driveBackups: { findFirst: vi.fn() },
    },
    select: vi.fn(),
  },
}));
vi.mock('@pagespace/lib/services/page-content-store', () => ({
  readPageContent: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { readPageContent } from '@pagespace/lib/services/page-content-store';

const mockAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sid',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const makeRequest = (driveId: string, backupId: string, query = '') =>
  new Request(`https://example.com/api/drives/${driveId}/backups/${backupId}/pages${query}`);

const makeParams = (driveId: string, backupId: string) => ({
  params: Promise.resolve({ driveId, backupId }),
});

const readyBackup = { id: 'backup_1', driveId: 'drive_1', status: 'ready' };

const pageRow = (pageId: string, parentId: string | null = null) => ({
  pageId,
  title: `Page ${pageId}`,
  type: 'document',
  parentId,
  position: 0,
  isTrashed: false,
  stateHash: null,
  contentRef: null,
});

function mockSelectChain(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const leftJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ leftJoin });
  vi.mocked(db.select).mockReturnValue({ from } as never);
}

describe('GET /api/drives/[driveId]/backups/[backupId]/pages', () => {
  const userId = 'user_1';
  const driveId = 'drive_1';
  const backupId = 'backup_1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth(userId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    vi.mocked(db.query.driveBackups.findFirst).mockResolvedValue(readyBackup as never);
    mockSelectChain([pageRow('p1')]);
    vi.mocked(readPageContent).mockResolvedValue('page content');
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(401);
  });

  it('returns 403 when not drive owner or admin', async () => {
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(403);
  });

  it('returns 404 when backup not found', async () => {
    vi.mocked(db.query.driveBackups.findFirst).mockResolvedValue(undefined as never);
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(404);
  });

  it('returns 404 when backup driveId does not match route driveId', async () => {
    vi.mocked(db.query.driveBackups.findFirst).mockResolvedValue({ ...readyBackup, driveId: 'other' } as never);
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(404);
  });

  it('includeContent omitted → content field absent on nodes', async () => {
    mockSelectChain([{ ...pageRow('p1'), contentRef: 'ref-1' }]);
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(readPageContent).not.toHaveBeenCalled();
    expect(body.pages[0]).not.toHaveProperty('content');
  });

  it('includeContent=true → content field present, readPageContent called per page', async () => {
    mockSelectChain([{ ...pageRow('p1'), contentRef: 'ref-1' }]);
    vi.mocked(readPageContent).mockResolvedValue('hello world');
    const res = await GET(makeRequest(driveId, backupId, '?includeContent=true'), makeParams(driveId, backupId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(readPageContent).toHaveBeenCalledWith('ref-1');
    expect(body.pages[0].content).toBe('hello world');
  });

  it('S3 failure for one page (includeContent=true) → that node missing content, rest succeeds', async () => {
    mockSelectChain([
      { ...pageRow('p1'), contentRef: 'ref-1' },
      { ...pageRow('p2'), contentRef: 'ref-2' },
    ]);
    vi.mocked(readPageContent)
      .mockResolvedValueOnce('good content')
      .mockRejectedValueOnce(new Error('S3 error'));
    const res = await GET(makeRequest(driveId, backupId, '?includeContent=true'), makeParams(driveId, backupId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pages).toHaveLength(2);
    const p1 = body.pages.find((p: { pageId: string }) => p.pageId === 'p1');
    const p2 = body.pages.find((p: { pageId: string }) => p.pageId === 'p2');
    expect(p1 || p2).toBeTruthy();
    // One should have content, one should not
    const withContent = [p1, p2].find((p) => 'content' in p);
    const withoutContent = [p1, p2].find((p) => !('content' in p));
    expect(withContent).toBeTruthy();
    expect(withoutContent).toBeTruthy();
  });

  it('trashed pages included by default (historical snapshot)', async () => {
    mockSelectChain([{ ...pageRow('p1'), isTrashed: true }]);
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pages[0].isTrashed).toBe(true);
  });

  it('returns 200 with pages array on success', async () => {
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('pages');
    expect(Array.isArray(body.pages)).toBe(true);
  });
});
