import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Contract tests for POST /api/drives/[driveId]/share-links
//
// Focused on the HOME_DRIVE guard: the route must map the HOME_DRIVE error
// from createDriveShareLink to a 403, not a 500.
// ============================================================================

vi.mock('@pagespace/lib/permissions/share-link-service', () => ({
  createDriveShareLink: vi.fn(),
  listDriveShareLinks: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateWithEnforcedContext: vi.fn(),
  isEnforcedAuthError: vi.fn(() => false),
}));

vi.mock('@/lib/share-url', () => ({
  getShareUrl: vi.fn((token: string) => `https://share.example.com/${token}`),
}));

import { POST } from '../route';
import { createDriveShareLink } from '@pagespace/lib/permissions/share-link-service';
import { authenticateWithEnforcedContext, isEnforcedAuthError } from '@/lib/auth';

const mockCtx = { userId: 'user-1' };
const mockAuth = { ctx: mockCtx };

const buildPost = (driveId: string, body?: unknown) =>
  new Request(`https://example.com/api/drives/${driveId}/share-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

describe('POST /api/drives/[driveId]/share-links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateWithEnforcedContext).mockResolvedValue(mockAuth as never);
    vi.mocked(isEnforcedAuthError).mockReturnValue(false);
  });

  it('returns 201 with the link when drive is STANDARD', async () => {
    vi.mocked(createDriveShareLink).mockResolvedValue({
      ok: true,
      data: { id: 'link-1', rawToken: 'tok123' },
    } as never);

    const res = await POST(buildPost('drive-std'), createContext('drive-std'));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe('link-1');
  });

  // ==========================================================================
  // Home drive guard
  // ==========================================================================

  it('returns 403 when createDriveShareLink returns HOME_DRIVE error', async () => {
    vi.mocked(createDriveShareLink).mockResolvedValue({
      ok: false,
      error: 'HOME_DRIVE',
    } as never);

    const res = await POST(buildPost('drive-home'), createContext('drive-home'));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toMatch(/home/i);
  });
});
