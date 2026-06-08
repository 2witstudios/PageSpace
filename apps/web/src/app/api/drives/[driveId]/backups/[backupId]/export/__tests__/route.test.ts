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
vi.mock('@/services/api/backup-export-service', () => ({
  streamBackupExport: vi.fn(),
}));

import { GET } from '../route';
import { getExportContentDisposition } from '../utils';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { streamBackupExport } from '@/services/api/backup-export-service';

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
  new Request(`https://example.com/api/drives/${driveId}/backups/${backupId}/export`);

const makeParams = (driveId: string, backupId: string) => ({
  params: Promise.resolve({ driveId, backupId }),
});

async function* emptyStream(): AsyncGenerator<Buffer> {}

// ============================================================================
// getExportContentDisposition — pure function test
// ============================================================================

describe('getExportContentDisposition', () => {
  it('returns correct Content-Disposition header value', () => {
    expect(getExportContentDisposition('abc')).toBe('attachment; filename="backup-abc.zip"');
  });
});

// ============================================================================
// GET route — contract tests
// ============================================================================

describe('GET /api/drives/[driveId]/backups/[backupId]/export', () => {
  const userId = 'user_1';
  const driveId = 'drive_1';
  const backupId = 'backup_1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth(userId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(streamBackupExport).mockResolvedValue(emptyStream());
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(401);
  });

  it('returns 403 when streamBackupExport throws 403-class error', async () => {
    const err = Object.assign(new Error('Access denied'), { status: 403 });
    vi.mocked(streamBackupExport).mockRejectedValue(err);
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(403);
  });

  it('returns 400 when streamBackupExport throws 400-class error', async () => {
    const err = Object.assign(new Error('Not found'), { status: 400 });
    vi.mocked(streamBackupExport).mockRejectedValue(err);
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.status).toBe(400);
  });

  it('returns Content-Type: application/zip on success', async () => {
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.headers.get('Content-Type')).toBe('application/zip');
  });

  it('returns correct Content-Disposition header', async () => {
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="backup-${backupId}.zip"`);
  });

  it('returns Cache-Control: no-store', async () => {
    const res = await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('calls streamBackupExport with correct backupId, driveId, userId', async () => {
    await GET(makeRequest(driveId, backupId), makeParams(driveId, backupId));
    expect(streamBackupExport).toHaveBeenCalledWith(backupId, driveId, userId);
  });
});
