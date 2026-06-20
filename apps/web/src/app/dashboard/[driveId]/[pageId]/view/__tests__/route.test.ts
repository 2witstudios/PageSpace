import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id' },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
}));

vi.mock('@pagespace/lib/content/page-types.config', () => ({
  isFilePage: vi.fn((type: string) => type === 'FILE'),
}));

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';

const params = (driveId = 'drive-1', pageId = 'file-1') =>
  Promise.resolve({ driveId, pageId });

describe('GET /dashboard/[driveId]/[pageId]/view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: 'file-1',
      driveId: 'drive-1',
      type: 'FILE',
    } as never);
  });

  it('given an authorized file page in the requested drive, should redirect to the canonical file view API', async () => {
    const request = new Request('https://pagespace.ai/dashboard/drive-1/file-1/view');

    const response = await GET(request, { params: params() });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://pagespace.ai/api/files/file-1/view');
    expect(canUserViewPage).toHaveBeenCalledWith('user-1', 'file-1');
  });

  it('given no authenticated user, should return 401', async () => {
    vi.mocked(verifyAuth).mockResolvedValue(null as never);

    const response = await GET(
      new Request('https://pagespace.ai/dashboard/drive-1/file-1/view'),
      { params: params() },
    );

    expect(response.status).toBe(401);
  });

  it('given the page is not in the requested drive, should return 404 without permission checks', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: 'file-1',
      driveId: 'real-drive',
      type: 'FILE',
    } as never);

    const response = await GET(
      new Request('https://pagespace.ai/dashboard/attacker-drive/file-1/view'),
      { params: params('attacker-drive', 'file-1') },
    );

    expect(response.status).toBe(404);
    expect(canUserViewPage).not.toHaveBeenCalled();
  });

  it('given a non-file page, should return 404', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: 'doc-1',
      driveId: 'drive-1',
      type: 'DOCUMENT',
    } as never);

    const response = await GET(
      new Request('https://pagespace.ai/dashboard/drive-1/doc-1/view'),
      { params: params('drive-1', 'doc-1') },
    );

    expect(response.status).toBe(404);
  });

  it('given the user cannot view the file page, should return 403', async () => {
    vi.mocked(canUserViewPage).mockResolvedValue(false);

    const response = await GET(
      new Request('https://pagespace.ai/dashboard/drive-1/file-1/view'),
      { params: params() },
    );

    expect(response.status).toBe(403);
  });
});
