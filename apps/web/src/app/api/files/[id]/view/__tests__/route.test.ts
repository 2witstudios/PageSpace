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

vi.mock('@pagespace/lib/permissions/file-access', () => ({
    canUserAccessFile: vi.fn().mockResolvedValue(true),
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

const mockGeneratePresignedUrl = vi.fn().mockResolvedValue('https://fly.storage.tigris.dev/presigned-url');
vi.mock('@/lib/presigned-url', () => ({
  generatePresignedUrl: (...args: unknown[]) => mockGeneratePresignedUrl(...args),
  getPresignedUrlTtl: vi.fn().mockReturnValue(3600),
}));

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { canUserAccessFile } from '@pagespace/lib/permissions/file-access';

const mockUserId = 'user_123';
const mockFileId = 'file-1';
const VALID_HASH = 'a'.repeat(64);

describe('GET /api/files/[id]/view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({ id: mockUserId, email: 'test@test.com' } as unknown as Awaited<ReturnType<typeof verifyAuth>>);
    mockGeneratePresignedUrl.mockResolvedValue('https://fly.storage.tigris.dev/presigned-url');
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: mockFileId,
      title: 'test.pdf',
      type: 'FILE',
      filePath: VALID_HASH,
      mimeType: 'application/pdf',
      originalFileName: 'test.pdf',
      fileSize: 1024,
    } as never);
  });

  it('logs read audit event on file view', async () => {
    const request = new Request('http://localhost/api/files/file-1/view');

    await GET(request as never, { params: Promise.resolve({ id: mockFileId }) });

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.read', userId: mockUserId, resourceType: 'file', resourceId: mockFileId }
    );
  });

  it('redirects to presigned URL for file page', async () => {
    const request = new Request('http://localhost/api/files/file-1/view');
    const response = await GET(request as never, { params: Promise.resolve({ id: mockFileId }) });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://fly.storage.tigris.dev/presigned-url');
    expect(mockGeneratePresignedUrl).toHaveBeenCalledWith(VALID_HASH, 'original', expect.any(Number));
  });

  it('redirects to presigned URL for DM-linked null-drive file', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.query.files.findFirst).mockResolvedValue({
      id: mockFileId,
      driveId: null,
      storagePath: VALID_HASH,
      mimeType: 'image/png',
      sizeBytes: 10,
    } as never);
    vi.mocked(canUserAccessFile).mockResolvedValue(true);

    const request = new Request('http://localhost/api/files/file-1/view');
    const response = await GET(request as never, { params: Promise.resolve({ id: mockFileId }) });

    expect(response.status).toBe(302);
    expect(mockGeneratePresignedUrl).toHaveBeenCalledWith(VALID_HASH, 'original', expect.any(Number));
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuth).mockResolvedValue(null as never);

    const request = new Request('http://localhost/api/files/file-1/view');
    const response = await GET(request as never, { params: Promise.resolve({ id: mockFileId }) });

    expect(response.status).toBe(401);
  });

  it('returns 403 when user lacks access to file page', async () => {
    const { canUserViewPage } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(canUserViewPage).mockResolvedValueOnce(false);

    const request = new Request('http://localhost/api/files/file-1/view');
    const response = await GET(request as never, { params: Promise.resolve({ id: mockFileId }) });

    expect(response.status).toBe(403);
  });

  it('returns 403 when user lacks access to attachment file', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.query.files.findFirst).mockResolvedValue({
      id: mockFileId, driveId: null, storagePath: VALID_HASH, mimeType: 'image/png', sizeBytes: 10,
    } as never);
    vi.mocked(canUserAccessFile).mockResolvedValue(false);

    const request = new Request('http://localhost/api/files/file-1/view');
    const response = await GET(request as never, { params: Promise.resolve({ id: mockFileId }) });

    expect(response.status).toBe(403);
  });

  it('returns 404 when file not found in either table', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.query.files.findFirst).mockResolvedValue(null as never);

    const request = new Request('http://localhost/api/files/file-1/view');
    const response = await GET(request as never, { params: Promise.resolve({ id: mockFileId }) });

    expect(response.status).toBe(404);
  });
});
