import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findMany: vi.fn() },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values })),
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

vi.mock('@/lib/canvas/file-view-token', () => ({
  createCanvasFileViewToken: vi.fn(({ driveId, pageId }) => `token-for-${driveId}-${pageId}`),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

import { POST } from '../route';
import { verifyAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { createCanvasFileViewToken } from '@/lib/canvas/file-view-token';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const jsonRequest = (body: unknown) =>
  new Request('https://pagespace.ai/api/canvas/file-view-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/canvas/file-view-tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findMany).mockResolvedValue([
      { id: 'file-1', driveId: 'drive-1', type: 'FILE' },
    ] as never);
  });

  it('given an authorized file page ref, should mint a scoped dashboard view URL token', async () => {
    const response = await POST(jsonRequest({
      refs: [{ driveId: 'drive-1', pageId: 'file-1' }],
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      links: [{
        driveId: 'drive-1',
        pageId: 'file-1',
        url: '/dashboard/drive-1/file-1/view?token=token-for-drive-1-file-1',
      }],
    });
    expect(createCanvasFileViewToken).toHaveBeenCalledWith({
      driveId: 'drive-1',
      pageId: 'file-1',
    });
    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        eventType: 'auth.token.created',
        userId: 'user-1',
        resourceType: 'canvas_file_view_token',
        resourceId: 'bulk',
        details: { requested: 1, issued: 1 },
      }),
    );
  });

  it('given no authenticated user, should return 401', async () => {
    vi.mocked(verifyAuth).mockResolvedValue(null as never);

    const response = await POST(jsonRequest({
      refs: [{ driveId: 'drive-1', pageId: 'file-1' }],
    }));

    expect(response.status).toBe(401);
    expect(createCanvasFileViewToken).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        eventType: 'authz.access.denied',
        resourceType: 'canvas_file_view_token',
        resourceId: 'bulk',
      }),
    );
  });

  it('given a ref for a different drive, should omit it without minting a token', async () => {
    const response = await POST(jsonRequest({
      refs: [{ driveId: 'attacker-drive', pageId: 'file-1' }],
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ links: [] });
    expect(createCanvasFileViewToken).not.toHaveBeenCalled();
  });

  it('given a ref the user cannot view, should omit it without minting a token', async () => {
    vi.mocked(canUserViewPage).mockResolvedValue(false);

    const response = await POST(jsonRequest({
      refs: [{ driveId: 'drive-1', pageId: 'file-1' }],
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ links: [] });
    expect(createCanvasFileViewToken).not.toHaveBeenCalled();
  });

  it('given duplicate refs, should query and return one signed link', async () => {
    const response = await POST(jsonRequest({
      refs: [
        { driveId: 'drive-1', pageId: 'file-1' },
        { driveId: 'drive-1', pageId: 'file-1' },
      ],
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.links).toHaveLength(1);
  });
});
