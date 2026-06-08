import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isDriveOwnerOrAdmin: vi.fn(),
}));
vi.mock('@/services/api/restore-diff-service', () => ({
  fetchAndComputeRestoreDiff: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { fetchAndComputeRestoreDiff } from '@/services/api/restore-diff-service';

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

const makeRequest = (driveId: string, backupId: string) =>
  new Request(`https://example.com/api/drives/${driveId}/backups/${backupId}/diff`);

const makeParams = (driveId: string, backupId: string) => ({
  params: Promise.resolve({ driveId, backupId }),
});

const emptyDiff = { toCreate: [], toOverwrite: [], toOrphan: [], unchanged: [] };

describe('GET /api/drives/[driveId]/backups/[backupId]/diff', () => {
  const userId = 'user_1';
  const driveId = 'drive_1';
  const backupId = 'backup_1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth(userId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    vi.mocked(fetchAndComputeRestoreDiff).mockResolvedValue({
      ok: true,
      diff: emptyDiff,
      backupPageMap: new Map(),
    });
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

  it('returns 400 when backup not found or driveId mismatch', async () => {
    vi.mocked(fetchAndComputeRestoreDiff).mockResolvedValue({ ok: false, reason: 'not_found' });

    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(400);
  });

  it('returns 200 with diff on valid request', async () => {
    const diff = {
      toCreate: [{ pageId: 'p1', title: 'New', type: 'document' }],
      toOverwrite: [],
      toOrphan: [],
      unchanged: [],
    };
    vi.mocked(fetchAndComputeRestoreDiff).mockResolvedValue({
      ok: true,
      diff,
      backupPageMap: new Map(),
    });

    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ diff });
  });

  it('calls fetchAndComputeRestoreDiff with correct backupId and driveId', async () => {
    await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(fetchAndComputeRestoreDiff).toHaveBeenCalledWith(backupId, driveId, expect.anything());
  });
});
