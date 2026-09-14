/**
 * Phase 2 cluster test — pages (inline scope branch).
 *
 * Reorder gates a drive-scoped credential on its OWN drive role (OWNER/ADMIN)
 * inline, before handing off to a service that authorizes the USER. Written
 * against `isScopedMCPAuth`, that gate was skipped for an OAuth grant, so a
 * `drive:X:member` app acting for X's owner reordered with the owner's powers.
 * Real scope/principal helpers; authentication, DB and the service stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: { query: { pages: { findFirst: vi.fn() } } },
}));
vi.mock('@pagespace/db/operators', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/db/operators')>();
  return { ...actual, eq: vi.fn((field: unknown, value: unknown) => ({ field, value })) };
});
vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn().mockResolvedValue(undefined),
  createPageEventPayload: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  logSecurityEvent: vi.fn(),
}));
vi.mock('@/services/api', () => ({
  pageReorderService: {
    validateMove: vi.fn().mockResolvedValue({ valid: true }),
    reorderPage: vi.fn().mockResolvedValue({ success: true, driveId: 'drivex', pageTitle: 'P' }),
  },
}));
vi.mock('@pagespace/lib/permissions/app-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/permissions/app-permissions')>();
  return {
    ...actual,
    ...(await import('@/lib/auth/__tests__/oauth-principal-fixture')).stillMemberScopedResolvers(),
    getAppDriveMembership: vi.fn(),
  };
});
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateRequestWithOptions: vi.fn() };
});

import { PATCH } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { pageReorderService } from '@/services/api';
import { PARITY_USER_ID, mcpDriveKey, oauthDriveGrant, profileOnlyGrant } from '@/lib/auth/__tests__/oauth-principal-fixture';

const DRIVE_X = 'drivex';
const DRIVE_Y = 'drivey';
const PAGE_IN_X = 'pageinx';
const PAGE_IN_Y = 'pageiny';

const reorder = (pageId: string) =>
  PATCH(
    new Request('https://example.com/api/pages/reorder', {
      method: 'PATCH',
      body: JSON.stringify({ pageId, newParentId: null, newPosition: 1 }),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.query.pages.findFirst).mockImplementation((async (args: { where: { value: string } }) => {
    if (args.where.value === PAGE_IN_X) return { driveId: DRIVE_X };
    if (args.where.value === PAGE_IN_Y) return { driveId: DRIVE_Y };
    return undefined;
  }) as never);
  // The service authorizes the USER, who owns every drive here.
  vi.mocked(pageReorderService.reorderPage).mockResolvedValue({ success: true, driveId: DRIVE_X, pageTitle: 'P' } as never);
});

describe('PATCH /api/pages/reorder — OAuth principals', () => {
  it("denies a drive:X:member OAuth grant in X although the service would admit the owning user", async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'member'));
    const res = await reorder(PAGE_IN_X);
    expect(res.status).toBe(403);
    expect(pageReorderService.reorderPage).not.toHaveBeenCalled();
  });

  it('gives the same answer as a MEMBER-role mcp_ key in X (parity)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpDriveKey(DRIVE_X));
    vi.mocked(getAppDriveMembership).mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: PARITY_USER_ID });
    const res = await reorder(PAGE_IN_X);
    expect(res.status).toBe(403);
    expect(pageReorderService.reorderPage).not.toHaveBeenCalled();
  });

  it('admits a drive:X:admin OAuth grant in X (positive control)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'admin'));
    const res = await reorder(PAGE_IN_X);
    expect(res.status).toBe(200);
    expect(pageReorderService.reorderPage).toHaveBeenCalledTimes(1);
  });

  it('denies a drive:X:admin OAuth grant for a page in drive Y with the mcp scope body', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'admin'));
    const res = await reorder(PAGE_IN_Y);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This token does not have access to this drive' });
    expect(pageReorderService.reorderPage).not.toHaveBeenCalled();
  });

  it('denies a profile-only token everywhere', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(profileOnlyGrant());
    for (const pageId of [PAGE_IN_X, PAGE_IN_Y]) {
      const res = await reorder(pageId);
      expect(res.status).toBe(403);
    }
    expect(pageReorderService.reorderPage).not.toHaveBeenCalled();
  });
});
