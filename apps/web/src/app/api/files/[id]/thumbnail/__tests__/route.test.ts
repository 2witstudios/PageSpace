import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { query: { pages: { findFirst: vi.fn() } } },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id' } }));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  explainSignInRefusal: vi.fn().mockResolvedValue(null),
  canUserViewPage: vi.fn().mockResolvedValue(true),
}));
vi.mock('@pagespace/lib/content/page-types.config', () => ({
  isFilePage: vi.fn().mockReturnValue(true),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

const mockGeneratePresignedUrl = vi.fn();
vi.mock('@/lib/presigned-url', () => ({
  generatePresignedUrl: (...args: unknown[]) => mockGeneratePresignedUrl(...args),
}));

const mockIsHashBlocked = vi.fn();
vi.mock('@pagespace/lib/content-safety/blocklist', () => ({
  isHashBlocked: (...args: unknown[]) => mockIsHashBlocked(...args),
}));

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';

const HASH = 'a'.repeat(64);
const call = () =>
  GET(new Request('http://localhost/api/files/video-1/thumbnail') as never, { params: Promise.resolve({ id: 'video-1' }) });

describe('GET /api/files/[id]/thumbnail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    mockGeneratePresignedUrl.mockResolvedValue('https://files.example.com/signed-thumbnail');
    mockIsHashBlocked.mockResolvedValue(false);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: 'video-1',
      type: 'FILE',
      mimeType: 'video/mp4',
      extractionMetadata: { thumbnailKey: `cache/${HASH}/thumbnail.webp` },
    } as never);
  });

  it('redirects to a presigned URL for the cached thumbnail', async () => {
    const response = await call();

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://files.example.com/signed-thumbnail');
    expect(mockGeneratePresignedUrl).toHaveBeenCalledWith(HASH, 'thumbnail.webp', 3600);
  });

  it('answers a neutral 410 when the original was taken down, and signs no URL', async () => {
    mockIsHashBlocked.mockResolvedValue(true);

    const response = await call();

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'This file has been removed' });
    expect(mockIsHashBlocked).toHaveBeenCalledWith(HASH);
    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
  });

  it('answers 403, not 410, to someone with no access', async () => {
    mockIsHashBlocked.mockResolvedValue(true);
    vi.mocked(canUserViewPage).mockResolvedValue(false);

    const response = await call();

    expect(response.status).toBe(403);
    expect(mockIsHashBlocked).not.toHaveBeenCalled();
  });
});
