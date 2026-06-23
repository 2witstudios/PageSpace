import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: {
    id: 'pages.id',
    driveId: 'pages.driveId',
    title: 'pages.title',
    type: 'pages.type',
    content: 'pages.content',
    isTrashed: 'pages.isTrashed',
  },
  drives: {
    id: 'drives.id',
    name: 'drives.name',
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
  audit: vi.fn(),
}));

import { POST } from '../route';
import { verifyAuth } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/link-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockDbResult(row: Record<string, unknown> | null) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn().mockResolvedValue(row ? [row] : []),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

const mockPage = {
  id: 'page1',
  title: 'My Page',
  type: 'DOCUMENT',
  driveId: 'drive1',
  isTrashed: false,
  content: 'Hello world, this is some document content that goes on for more than one hundred characters in total.',
  driveName: 'My Drive',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/link-preview', () => {
  it('returns 401 when unauthenticated', async () => {
    (verifyAuth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(makeRequest({ pageId: 'page1', driveId: 'drive1' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when pageId is missing', async () => {
    (verifyAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'user1' });
    const res = await POST(makeRequest({ driveId: 'drive1' }));
    expect(res.status).toBe(400);
  });

  it('returns 200 with metadata when user has access', async () => {
    (verifyAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'user1' });
    (canUserViewPage as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    mockDbResult(mockPage);

    const res = await POST(makeRequest({ pageId: 'page1', driveId: 'drive1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('page1');
    expect(body.title).toBe('My Page');
    expect(body.type).toBe('DOCUMENT');
    expect(body.driveName).toBe('My Drive');
  });

  it('returns 404 (not 403) when user lacks view access', async () => {
    (verifyAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'user1' });
    (canUserViewPage as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const res = await POST(makeRequest({ pageId: 'page1', driveId: 'drive1' }));
    expect(res.status).toBe(404);
    // explicitly assert it's not 403
    expect(res.status).not.toBe(403);
  });

  it('returns 404 for a trashed page', async () => {
    (verifyAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'user1' });
    (canUserViewPage as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    mockDbResult({ ...mockPage, isTrashed: true });

    const res = await POST(makeRequest({ pageId: 'page1', driveId: 'drive1' }));
    expect(res.status).toBe(404);
  });

  it('returns 404 when page is not found in DB', async () => {
    (verifyAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'user1' });
    (canUserViewPage as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    mockDbResult(null);

    const res = await POST(makeRequest({ pageId: 'page1', driveId: 'drive1' }));
    expect(res.status).toBe(404);
  });

  it('includes snippet (first 100 chars) for DOCUMENT type', async () => {
    (verifyAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'user1' });
    (canUserViewPage as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    mockDbResult(mockPage);

    const res = await POST(makeRequest({ pageId: 'page1', driveId: 'drive1' }));
    const body = await res.json();
    expect(body.snippet).toBeDefined();
    expect(body.snippet.length).toBeLessThanOrEqual(100);
  });

  it('does not include snippet for non-DOCUMENT types', async () => {
    (verifyAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'user1' });
    (canUserViewPage as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    mockDbResult({ ...mockPage, type: 'CHANNEL' });

    const res = await POST(makeRequest({ pageId: 'page1', driveId: 'drive1' }));
    const body = await res.json();
    expect(body.snippet).toBeUndefined();
  });

  it('resolves driveId from DB when not provided in request body', async () => {
    (verifyAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'user1' });
    (canUserViewPage as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    mockDbResult(mockPage);

    // POST with only pageId, no driveId
    const res = await POST(makeRequest({ pageId: 'page1' }));
    expect(res.status).toBe(200);
  });
});
