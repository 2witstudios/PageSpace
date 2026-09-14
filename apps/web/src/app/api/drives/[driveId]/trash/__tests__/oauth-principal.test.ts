/**
 * Phase 2 cluster test — drives (inline scope branch).
 *
 * The trash route decides owner/admin authority INLINE: a drive-scoped
 * credential is gated on its own role, everyone else on the user's ownership.
 * Written against `isScopedMCPAuth` that branch was false for an OAuth grant,
 * so a `drive:X:member` app acting for X's OWNER got the owner's trash. Uses
 * the REAL scope/principal helpers; only authentication and DB edges are
 * stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      drives: { findFirst: vi.fn() },
      pages: { findMany: vi.fn() },
    },
    select: vi.fn(),
  },
}));
vi.mock('@pagespace/lib/content/tree-utils', () => ({ buildTree: vi.fn(() => []) }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  logSecurityEvent: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/app-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/permissions/app-permissions')>();
  return { ...actual, getAppDriveMembership: vi.fn() };
});
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateRequestWithOptions: vi.fn() };
});

import { GET } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { PARITY_USER_ID, mcpDriveKey, oauthDriveGrant, profileOnlyGrant } from '@/lib/auth/__tests__/oauth-principal-fixture';

const DRIVE_X = 'drivex';
const DRIVE_Y = 'drivey';

const trash = (driveId: string) =>
  GET(new Request(`https://example.com/api/drives/${driveId}/trash`), { params: Promise.resolve({ driveId }) });

beforeEach(() => {
  vi.clearAllMocks();
  // The requesting user OWNS both drives — so any denial below is the grant's
  // narrowing, never the user's lack of authority.
  vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: DRIVE_X, ownerId: PARITY_USER_ID } as never);
  vi.mocked(db.query.pages.findMany).mockResolvedValue([]);
});

describe('GET /api/drives/[driveId]/trash — OAuth principals', () => {
  it('denies a drive:X:member OAuth grant in X even though the user owns X (the grant role, not the owner, decides)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'member'));
    const res = await trash(DRIVE_X);
    expect(res.status).toBe(403);
    expect(db.query.pages.findMany).not.toHaveBeenCalled();
  });

  it('gives the same answer as a MEMBER-role mcp_ key in X (parity)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpDriveKey(DRIVE_X));
    vi.mocked(getAppDriveMembership).mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: PARITY_USER_ID });
    const res = await trash(DRIVE_X);
    expect(res.status).toBe(403);
  });

  it('admits a drive:X:admin OAuth grant in X (positive control — the denials are not vacuous)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'admin'));
    const res = await trash(DRIVE_X);
    expect(res.status).toBe(200);
  });

  it('denies a drive:X:admin OAuth grant in drive Y', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'admin'));
    const res = await trash(DRIVE_Y);
    expect(res.status).toBe(403);
    expect(db.query.pages.findMany).not.toHaveBeenCalled();
  });

  it('denies a profile-only token in every drive', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(profileOnlyGrant());
    for (const driveId of [DRIVE_X, DRIVE_Y]) {
      const res = await trash(driveId);
      expect(res.status).toBe(403);
    }
    expect(db.query.pages.findMany).not.toHaveBeenCalled();
  });
});
