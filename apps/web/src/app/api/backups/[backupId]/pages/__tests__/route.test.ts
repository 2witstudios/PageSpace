import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
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
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { readPageContent } from '@pagespace/lib/services/page-content-store';
import type { SessionAuthResult, AuthError } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

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

const makeRequest = (backupId: string, query = '') =>
  new Request(`https://example.com/api/backups/${backupId}/pages${query}`);

const makeParams = (backupId: string) => ({
  params: Promise.resolve({ backupId }),
});

const readyBackup = { id: 'backup_1', driveId: 'drive_1', status: 'ready', label: null, source: 'manual', createdAt: new Date() };

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

describe('GET /api/backups/[backupId]/pages', () => {
  const userId = 'user_1';
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
    const res = await GET(makeRequest(backupId), makeParams(backupId));
    expect(res.status).toBe(401);
  });

  it('returns 403 when not drive owner or admin', async () => {
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    const res = await GET(makeRequest(backupId), makeParams(backupId));
    expect(res.status).toBe(403);
  });

  it('returns 404 when backup not found', async () => {
    vi.mocked(db.query.driveBackups.findFirst).mockResolvedValue(undefined as never);
    const res = await GET(makeRequest(backupId), makeParams(backupId));
    expect(res.status).toBe(404);
  });

  it('uses backup.driveId for permission check (not a URL param)', async () => {
    const res = await GET(makeRequest(backupId), makeParams(backupId));
    expect(res.status).toBe(200);
    expect(isDriveOwnerOrAdmin).toHaveBeenCalledWith(userId, readyBackup.driveId);
  });

  it('includeContent omitted → content field absent on nodes', async () => {
    mockSelectChain([{ ...pageRow('p1'), contentRef: 'ref-1' }]);
    const res = await GET(makeRequest(backupId), makeParams(backupId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(readPageContent).not.toHaveBeenCalled();
    expect(body.pages[0]).not.toHaveProperty('content');
  });

  it('includeContent=true → content field present, readPageContent called per page', async () => {
    mockSelectChain([{ ...pageRow('p1'), contentRef: 'ref-1' }]);
    vi.mocked(readPageContent).mockResolvedValue('hello world');
    const res = await GET(makeRequest(backupId, '?includeContent=true'), makeParams(backupId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(readPageContent).toHaveBeenCalledWith('ref-1');
    expect(body.pages[0].content).toBe('hello world');
  });

  it('returns 200 with pages array and backup metadata on success', async () => {
    const res = await GET(makeRequest(backupId), makeParams(backupId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('pages');
    expect(Array.isArray(body.pages)).toBe(true);
    expect(body.backup).toMatchObject({ id: backupId });
  });
});
