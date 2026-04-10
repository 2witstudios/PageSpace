/**
 * Security audit tests for /api/files/[id]/download
 * Verifies securityAudit.logDataAccess is called for GET (read, download).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
      files: { findFirst: vi.fn() },
    },
  },
  pages: { id: 'id' },
  files: { id: 'id' },
  eq: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  PageType: { FILE: 'FILE' },
  canUserViewPage: vi.fn().mockResolvedValue(true),
  isFilePage: vi.fn().mockReturnValue(true),
  createPageServiceToken: vi.fn().mockResolvedValue({ token: 'mock-token' }),
  createDriveServiceToken: vi.fn().mockResolvedValue({ token: 'mock-token' }),
}));

vi.mock('@pagespace/lib/permissions', () => ({
  canUserAccessFile: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/utils/file-security', () => ({
  sanitizeFilenameForHeader: vi.fn((name: string) => name),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  securityAudit: {
    logDataAccess: vi.fn().mockResolvedValue(undefined),
  },
}));

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { securityAudit } from '@pagespace/lib/server';
import { db } from '@pagespace/db';

const mockUserId = 'user_123';
const mockFileId = 'file-1';

describe('GET /api/files/[id]/download audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({ id: mockUserId, email: 'test@test.com' } as ReturnType<typeof verifyAuth> extends Promise<infer T> ? T : never);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: mockFileId,
      title: 'test.pdf',
      type: 'FILE',
      filePath: 'hash-123',
      mimeType: 'application/pdf',
      originalFileName: 'test.pdf',
      fileSize: 1024,
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
    });
  });

  it('logs read audit event with download action', async () => {
    const request = new Request('http://localhost/api/files/file-1/download');

    await GET(request as never, { params: Promise.resolve({ id: mockFileId }) });

    expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
      mockUserId, 'read', 'file', mockFileId, { action: 'download' }
    );
  });
});
