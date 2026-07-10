import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Contract tests for POST /api/pages/[pageId]/share-links
//
// Focused on the HOME_DRIVE guard: the route must map the HOME_DRIVE error
// from createPageShareLink to a 403, not a 500.
// ============================================================================

vi.mock('@pagespace/lib/permissions/share-link-service', () => ({
  createPageShareLink: vi.fn(),
  listPageShareLinks: vi.fn(),
}));

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateWithEnforcedContext: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isEnforcedAuthError: vi.fn(() => false),
}));

vi.mock('@/lib/share-url', () => ({
  getShareUrl: vi.fn((token: string) => `https://share.example.com/${token}`),
}));

import { POST } from '../route';
import { createPageShareLink } from '@pagespace/lib/permissions/share-link-service';
import { authenticateWithEnforcedContext } from '@/lib/auth/request-auth';
import { isEnforcedAuthError } from '@/lib/auth/auth-core';

const mockCtx = { userId: 'user-1' };
const mockAuth = { ctx: mockCtx };

const buildPost = (pageId: string, body?: unknown) =>
  new Request(`https://example.com/api/pages/${pageId}/share-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const createContext = (pageId: string) => ({
  params: Promise.resolve({ pageId }),
});

describe('POST /api/pages/[pageId]/share-links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateWithEnforcedContext).mockResolvedValue(mockAuth as never);
    vi.mocked(isEnforcedAuthError).mockReturnValue(false);
  });

  it('returns 201 with the link when page is in a STANDARD drive', async () => {
    vi.mocked(createPageShareLink).mockResolvedValue({
      ok: true,
      data: { id: 'link-1', rawToken: 'tok123' },
    } as never);

    const res = await POST(buildPost('page-std'), createContext('page-std'));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe('link-1');
  });

  // ==========================================================================
  // Home drive guard
  // ==========================================================================

  it('returns 403 when createPageShareLink returns HOME_DRIVE error', async () => {
    vi.mocked(createPageShareLink).mockResolvedValue({
      ok: false,
      error: 'HOME_DRIVE',
    } as never);

    const res = await POST(buildPost('page-home'), createContext('page-home'));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toMatch(/home/i);
  });
});
