/**
 * Phase 2 cluster test — MCP document surface (inline scope branch).
 *
 * `/api/mcp/documents` read its drive ceiling as
 * `isMCPAuthResult(auth) ? auth.allowedDriveIds : []`, so any non-MCP
 * credential got `[]` — "no restriction" — and skipped the drive-scope gate.
 * An OAuth grant must meet the same gate, with the same 403 body, as the
 * drive-scoped `mcp_` key it stands in for. Real scope/principal helpers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@pagespace/db/db', () => ({
  db: { query: { pages: { findFirst: vi.fn() } } },
}));
vi.mock('@pagespace/db/operators', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/db/operators')>();
  return { ...actual, eq: vi.fn((field: unknown, value: unknown) => ({ field, value })) };
});
vi.mock('@pagespace/lib/logging/logger-config', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    loggers: { api: { ...child, child: vi.fn(() => child) }, security: { warn: vi.fn() }, ai: { ...child, child: vi.fn(() => child) } },
    logger: { child: vi.fn(() => child) },
    logSecurityEvent: vi.fn(),
  };
});
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@/lib/websocket', () => ({ broadcastPageEvent: vi.fn(), createPageEventPayload: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ getActorInfo: vi.fn().mockResolvedValue({}) }));
vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: vi.fn(),
  PageRevisionMismatchError: class extends Error {},
}));
vi.mock('@pagespace/lib/permissions/app-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/permissions/app-permissions')>();
  return { ...actual, getAppAccessLevel: vi.fn(), getScopedAccessLevel: vi.fn() };
});
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateMCPRequest: vi.fn(), authenticateRequestWithOptions: vi.fn() };
});

import { POST } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateMCPRequest, authenticateRequestWithOptions, type AuthResult } from '@/lib/auth';
import { getAppAccessLevel, getScopedAccessLevel } from '@pagespace/lib/permissions/app-permissions';
import { mcpDriveKey, oauthDriveGrant, profileOnlyGrant } from '@/lib/auth/__tests__/oauth-principal-fixture';

const DRIVE_X = 'drivex';
const DRIVE_Y = 'drivey';
const VIEW = { canView: true, canEdit: true, canShare: false, canDelete: false };

function page(id: string, driveId: string) {
  return { id, title: 'Doc', content: 'one\ntwo', type: 'DOCUMENT', revision: 1, parentId: null, driveId, drive: { id: driveId, ownerId: 'owner' } };
}

function authenticateAs(principal: AuthResult) {
  vi.mocked(authenticateMCPRequest).mockResolvedValue(principal);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal);
}

const read = (pageId: string) =>
  POST(
    new NextRequest('https://example.com/api/mcp/documents', {
      method: 'POST',
      body: JSON.stringify({ operation: 'read', pageId }),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.query.pages.findFirst).mockImplementation((async (args: { where: { value: string } }) =>
    args.where.value === 'page-y' ? page('page-y', DRIVE_Y) : page('page-x', DRIVE_X)) as never);
  // Every resolver would ALLOW — only the drive-scope gate can refuse below.
  vi.mocked(getScopedAccessLevel).mockResolvedValue(VIEW);
  vi.mocked(getAppAccessLevel).mockResolvedValue(VIEW);
});

describe('POST /api/mcp/documents — OAuth principals', () => {
  it('refuses a drive:X OAuth grant a page in Y with the drive-scope 403 an mcp_ key gets', async () => {
    authenticateAs(oauthDriveGrant(DRIVE_X, 'member'));
    const res = await read('page-y');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This token does not have access to this drive' });
  });

  it('is the identical refusal a drive:X mcp_ key gets (parity)', async () => {
    authenticateAs(mcpDriveKey(DRIVE_X));
    const res = await read('page-y');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This token does not have access to this drive' });
  });

  it('reads a page in X under the grant (positive control)', async () => {
    authenticateAs(oauthDriveGrant(DRIVE_X, 'member'));
    const res = await read('page-x');
    expect(res.status).toBe(200);
  });

  it('refuses a profile-only token every page', async () => {
    authenticateAs(profileOnlyGrant());
    for (const pageId of ['page-x', 'page-y']) {
      const res = await read(pageId);
      expect(res.status).toBe(403);
    }
  });
});
