/**
 * Security audit tests for /api/files/[id]/download
 * Verifies auditRequest is called for GET (read, download).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
      files: { findFirst: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id' },
}));
vi.mock('@pagespace/db/schema/storage', () => ({
  files: { id: 'id' },
}));

vi.mock('@pagespace/lib/utils/enums', () => ({
    PageType: { FILE: 'FILE' },
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserViewPage: vi.fn().mockResolvedValue(true),
}));
vi.mock('@pagespace/lib/content/page-types.config', () => ({
    isFilePage: vi.fn().mockReturnValue(true),
}));
vi.mock('@pagespace/lib/services/validated-service-token', () => ({
    createPageServiceToken: vi.fn().mockResolvedValue({ token: 'mock-token' }),
    createDriveServiceToken: vi.fn().mockResolvedValue({ token: 'mock-token' }),
    createFileServiceToken: vi.fn().mockResolvedValue({ token: 'mock-file-token' }),
}));

vi.mock('@pagespace/lib/permissions/file-access', () => ({
    canUserAccessFile: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/utils/file-security', () => ({
  sanitizeFilenameForHeader: vi.fn((name: string) => name),
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

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { canUserAccessFile } from '@pagespace/lib/permissions/file-access';
import { createFileServiceToken } from '@pagespace/lib/services/validated-service-token';

const mockUserId = 'user_123';
const mockFileId = 'file-1';

describe('GET /api/files/[id]/download audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({ id: mockUserId, email: 'test@test.com' } as unknown as Awaited<ReturnType<typeof verifyAuth>>);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: mockFileId,
      title: 'test.pdf',
      type: 'FILE',
      filePath: 'hash-123',
      mimeType: 'application/pdf',
      originalFileName: 'test.pdf',
      fileSize: 1024,
    } as never);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
    });
  });

  it('logs read audit event with download action', async () => {
    const request = new Request('http://localhost/api/files/file-1/download');

    await GET(request as never, { params: Promise.resolve({ id: mockFileId }) });

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.read', userId: mockUserId, resourceType: 'file', resourceId: mockFileId, details: { action: 'download' } }
    );
  });

  it('downloads a DM-linked null-drive file with a file-bound read token', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.query.files.findFirst).mockResolvedValue({
      id: mockFileId,
      driveId: null,
      storagePath: 'a'.repeat(64),
      mimeType: 'image/png',
      sizeBytes: 10,
    } as never);
    vi.mocked(canUserAccessFile).mockResolvedValue(true);

    const request = new Request('http://localhost/api/files/file-1/download?filename=dm.png');
    const response = await GET(request as never, { params: Promise.resolve({ id: mockFileId }) });

    expect(response.status).toBe(200);
    expect(createFileServiceToken).toHaveBeenCalledWith(
      mockUserId,
      mockFileId,
      ['files:read'],
      '5m'
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://processor:3003/cache/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/original',
      expect.objectContaining({
        headers: { Authorization: 'Bearer mock-file-token' },
      })
    );
  });
});
