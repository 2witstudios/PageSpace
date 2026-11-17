/**
 * Contract tests for POST /api/pages/bulk-copy
 *
 * These tests verify the route handler's contract:
 * - Authentication and authorization checks
 * - Request validation via Zod schema
 * - MCP token scope checks for source and target drives
 * - Drive/page existence validation
 * - Permission checks (view source, edit target)
 * - Recursive child copying
 * - Side effects: broadcast, activity logging
 * - Error handling
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ── Mocks (before imports) ──────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result !== null && typeof result === 'object' && 'error' in (result as Record<string, unknown>)),
  checkMCPDriveScope: vi.fn(() => null),
  getAllowedDriveIds: vi.fn(() => []),
  isMCPAuthResult: vi.fn(() => false),
  isScopedMCPAuth: vi.fn(() => false),
  canPrincipalViewPage: vi.fn(async (auth: { userId: string }, pageId: string) => {
    const { canUserViewPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserViewPage(credentialActor(auth.userId, null), pageId);
  }),
}));

vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppDriveMembership: vi.fn(),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn().mockResolvedValue(undefined),
  createPageEventPayload: vi.fn((driveId: string, pageId: string, type: string) => ({
    driveId, pageId, type,
  })),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
const mockFindBlockedUploads = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/content-safety/upload-gate', () => ({
  findBlockedUploads: mockFindBlockedUploads,
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  explainSignInRefusal: vi.fn().mockResolvedValue(null),
    canUserViewPage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
  logPageActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/change-group', () => ({
    createChangeGroupId: vi.fn(() => 'change-group-123'),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'new-page-id'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
  isCuid: vi.fn(() => true),
}));

// The org-aware relationship is the gate (its pure role decisions stay real).
vi.mock('@pagespace/lib/permissions/drive-relationship-loader', () => ({
  loadDriveRelationship: vi.fn(),
}));

// [D-OW-33] the lapse guard: no org (null) unless a test lapses the source drive.
const checkDriveMayLoosen = vi.hoisted(() => vi.fn(async (_tx?: unknown, _driveId?: unknown, _loosens?: unknown): Promise<unknown> => null));
vi.mock('@pagespace/lib/permissions/org-lapse-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/permissions/org-lapse-guard')>()),
  checkDriveMayLoosen,
}));
const mockLoadFileStoragePaths = vi.fn();
vi.mock('@/lib/upload/stored-content-hash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload/stored-content-hash')>()),
  loadFileStoragePaths: (...args: unknown[]) => mockLoadFileStoragePaths(...args),
}));
vi.mock('@pagespace/db/db', () => {
  const txInsertValues = vi.fn().mockResolvedValue(undefined);
  const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });
  const txQueryPagesFindMany = vi.fn().mockResolvedValue([]);
  const tx = {
    insert: txInsert,
    query: { pages: { findMany: txQueryPagesFindMany } },
  };
  const transaction = vi.fn(async (fn: (t: unknown) => Promise<void>) => {
    await fn(tx);
  });
  return {
    db: {
      query: {
        drives: { findFirst: vi.fn() },
        driveMembers: { findFirst: vi.fn() },
        pages: { findFirst: vi.fn(), findMany: vi.fn() },
      },
      transaction,
    },
    __test__: { txInsert, txInsertValues, txQueryPagesFindMany, transaction },
  };
});
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => [a, b]),
  inArray: vi.fn((a: unknown, b: unknown) => [a, b]),
  desc: vi.fn((a: unknown) => a),
  isNull: vi.fn((a: unknown) => a),
  isNotNull: vi.fn((a: unknown) => ({ _isNotNull: true, col: a })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', parentId: 'parentId', position: 'position', isTrashed: 'isTrashed' },
  drives: { id: 'id' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { driveId: 'driveMembers.driveId', userId: 'driveMembers.userId', acceptedAt: 'driveMembers.acceptedAt' },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────

import { POST } from '../route';
import type { DriveRelationship } from '@pagespace/lib/permissions/drive-relationship';
import { loadDriveRelationship } from '@pagespace/lib/permissions/drive-relationship-loader';
import { authenticateRequestWithOptions, checkMCPDriveScope, getAllowedDriveIds, isMCPAuthResult } from '@/lib/auth';
import { broadcastPageEvent } from '@/lib/websocket';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
// @ts-expect-error - accessing test-only export
import { db, __test__ as dbTest } from '@pagespace/db/db';
import { createId } from '@paralleldrive/cuid2';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';

const { txInsert, txInsertValues, txQueryPagesFindMany, transaction: mockTransaction } = dbTest as {
  txInsert: ReturnType<typeof vi.fn>;
  txInsertValues: ReturnType<typeof vi.fn>;
  txQueryPagesFindMany: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

// ── Helpers ─────────────────────────────────────────────────────────────

const mockUserId = 'user_123';
const mockDriveId = 'drive_target';
const mockSourceDriveId = 'drive_source';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/pages/bulk-copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const mockSourcePage = (overrides = {}) => ({
  id: 'page-1',
  title: 'Source Page',
  type: 'DOCUMENT',
  content: '<p>Hello</p>',
  driveId: mockSourceDriveId,
  parentId: null,
  position: 1,
  revision: 5,
  stateHash: 'hash',
  isTrashed: false,
  aiProvider: null,
  aiModel: null,
  systemPrompt: null,
  enabledTools: null,
  isPaginated: null,
  includeDrivePrompt: null,
  agentDefinition: null,
  visibleToGlobalAssistant: null,
  includePageTree: null,
  pageTreeScope: null,
  fileSize: null,
  mimeType: null,
  originalFileName: null,
  filePath: null,
  fileMetadata: null,
  processingStatus: null,
  processingError: null,
  processedAt: null,
  extractionMethod: null,
  extractionMetadata: null,
  contentHash: null,
  ...overrides,
});

const validBody = {
  pageIds: ['page-1'],
  targetDriveId: mockDriveId,
  targetParentId: null,
  includeChildren: true,
};

const NONE: DriveRelationship = { isOwner: false, membership: null };
const asMember = (role: 'OWNER' | 'ADMIN' | 'MEMBER', source: 'invite' | 'org' = 'invite'): DriveRelationship => ({
  isOwner: false,
  membership: { role, customRoleId: null, source, auditOrgAdminPrivateAccess: false, openDriveFloor: null },
});
/** The non-lead relationship loadDriveRelationship answers; the lead (drives.ownerId) is always LEAD. */
let nonLead: DriveRelationship = NONE;
const setRelationship = (rel: DriveRelationship) => { nonLead = rel; };

function setupSuccessScenario() {
  nonLead = NONE;
  vi.mocked(loadDriveRelationship).mockImplementation(async (actor, drive) =>
    drive.ownerId === actor.userId ? { isOwner: true, membership: null } : nonLead);

  // Auth
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
  vi.mocked(checkMCPDriveScope).mockReturnValue(null);
  vi.mocked(getAllowedDriveIds).mockReturnValue([]);
  vi.mocked(isMCPAuthResult).mockReturnValue(false);

  // DB queries
  vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: mockUserId } as never);
  vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined as never);
  vi.mocked(db.query.pages.findMany).mockResolvedValue([mockSourcePage()] as never);
  vi.mocked(db.query.pages.findFirst).mockResolvedValue({ position: 5 } as never);

  // Permissions
  vi.mocked(canUserViewPage).mockResolvedValue(true);

  // Transaction mocks
  txInsertValues.mockResolvedValue(undefined);
  txInsert.mockReturnValue({ values: txInsertValues });
  mockFindBlockedUploads.mockResolvedValue(new Set());

  txQueryPagesFindMany.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (fn: (t: unknown) => Promise<void>) => {
    await fn({
      insert: txInsert,
      query: { pages: { findMany: txQueryPagesFindMany } },
    });
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('POST /api/pages/bulk-copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessScenario();
  });

  // ── Authentication ──────────────────────────────────────────────────

  describe('authentication', () => {
    it('returns auth error when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(401);
    });
  });

  // ── Validation ──────────────────────────────────────────────────────

  describe('validation', () => {
    it('returns 400 when pageIds is empty', async () => {
      const response = await POST(createRequest({ ...validBody, pageIds: [] }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('At least one page ID is required');
    });

    it('returns 400 when pageIds is missing', async () => {
      const response = await POST(createRequest({ targetDriveId: mockDriveId, targetParentId: null }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid input: expected array, received undefined');
    });

    it('returns 400 when targetDriveId is missing', async () => {
      const response = await POST(createRequest({ pageIds: ['page-1'], targetParentId: null }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid input: expected string, received undefined');
    });

    it('returns 400 when targetDriveId is empty string', async () => {
      const response = await POST(createRequest({ pageIds: ['page-1'], targetDriveId: '', targetParentId: null }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Target drive ID is required');
    });

    it('defaults includeChildren to true when not provided', async () => {
      const response = await POST(createRequest({
        pageIds: ['page-1'],
        targetDriveId: mockDriveId,
        targetParentId: null,
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ── Target drive checks ─────────────────────────────────────────────

  describe('target drive validation', () => {
    it('returns 404 when target drive does not exist', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/target drive not found/i);
    });

    it('returns MCP scope error when token lacks target drive access', async () => {
      vi.mocked(checkMCPDriveScope).mockReturnValue(
        NextResponse.json({ error: 'Token scope error' }, { status: 403 })
      );

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(403);
    });
  });

  // ── Target drive permission ─────────────────────────────────────────

  describe('target drive permission', () => {
    it('allows when user is drive owner', async () => {
      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('allows when user is drive ADMIN member', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: 'other-user' } as never);
      setRelationship(asMember('ADMIN'));

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('allows when user is drive OWNER member', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: 'other-user' } as never);
      setRelationship(asMember('OWNER'));

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('returns 403 when user is only a VIEWER member', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: 'other-user' } as never);
      setRelationship(asMember('MEMBER'));

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission.*copy/i);
    });

    it('returns 403 when user has no membership', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: 'other-user' } as never);
      setRelationship(NONE);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission.*copy/i);
    });

    it('ORG-4 (partial) an org Admin with no drive_members row copies into an org drive', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: 'other-user', orgId: 'org_1', orgVisibility: 'PRIVATE' } as never);
      setRelationship(asMember('ADMIN'));

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(200);
      expect(loadDriveRelationship).toHaveBeenCalledWith(expect.objectContaining({ userId: mockUserId }), expect.objectContaining({ orgId: 'org_1', orgVisibility: 'PRIVATE' }));
    });

    it('X-6 (partial) a stale source=org ADMIN row opens nothing: the route never reads drive_members', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: 'other-user', orgId: 'org_1', orgVisibility: 'OPEN' } as never);
      // The row the old inline gate would have honoured.
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue({ role: 'ADMIN', source: 'org' } as never);
      setRelationship(NONE);

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(403);
      expect(db.query.driveMembers.findFirst).not.toHaveBeenCalled();
    });

    // Review C2 — pending ADMIN escalation. Adversarial pin against drift back
    // to the role-only predicate that allowed pending invitees to write into
    // a drive they had not joined.
    it('rejects pending ADMIN (acceptedAt IS NULL) — adversarial pending-admin-can-bulk-copy-into-unaccepted-drive path', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: mockDriveId, ownerId: 'other-user' } as never);
      // The org-aware relationship reads ACCEPTED rows only: a pending ADMIN invitation is no membership.
      setRelationship(NONE);

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(403);
      expect(db.query.driveMembers.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── Target parent validation ────────────────────────────────────────

  describe('target parent validation', () => {
    it('returns 404 when target parent does not exist', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

      const response = await POST(createRequest({ ...validBody, targetParentId: 'nonexistent-parent' }));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/target folder not found/i);
    });

    it('skips parent check when targetParentId is null', async () => {
      const response = await POST(createRequest({ ...validBody, targetParentId: null }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ── Source pages validation ─────────────────────────────────────────

  describe('source pages validation', () => {
    it('returns 404 when some source pages not found', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([] as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/some pages not found/i);
    });

    it('returns 403 when MCP token does not have access to source page drive', async () => {
      vi.mocked(getAllowedDriveIds).mockReturnValue(['drive-other']);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/token.*access.*source/i);
    });

    it('allows when MCP token has access to source page drive', async () => {
      vi.mocked(getAllowedDriveIds).mockReturnValue([mockSourceDriveId]);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('allows when getAllowedDriveIds returns empty (session auth / unscoped)', async () => {
      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ── View permission checks ──────────────────────────────────────────

  describe('view permission checks', () => {
    it('returns 403 when user cannot view a source page', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission.*copy.*page/i);
    });

    it('includes page title in permission error', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);
      vi.mocked(db.query.pages.findMany).mockResolvedValue([mockSourcePage({ title: 'Secret Doc' })] as never);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(body.error).toContain('Secret Doc');
    });
  });

  // ── Successful copy ─────────────────────────────────────────────────

  describe('successful copy', () => {
    it('SEAT-9 (partial) [D-OW-33] review P2-4 ruling: copying out of a lapsed org\'s drive into another drive answers 402 org_lapsed, checked against the SOURCE drive in the copy transaction, and copies nothing', async () => {
      checkDriveMayLoosen.mockResolvedValueOnce({ ok: false, code: 'org_lapsed', status: 402, message: 'lapsed' });
      const response = await POST(createRequest(validBody));
      expect(response.status).toBe(402);
      expect(await response.json()).toMatchObject({ code: 'org_lapsed' });
      expect(checkDriveMayLoosen).toHaveBeenCalledWith(expect.anything(), mockSourceDriveId, true);
      expect(txInsert).not.toHaveBeenCalled();
    });

    it('returns success with copiedCount', async () => {
      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.copiedCount).toBe(1);
    });

    it('runs copy within a transaction', async () => {
      await POST(createRequest(validBody));

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(typeof mockTransaction.mock.calls[0][0]).toBe('function');
    });

    it('creates page with (Copy) suffix in title', async () => {
      await POST(createRequest(validBody));

      expect(txInsert).toHaveBeenCalledWith({ id: 'id', driveId: 'driveId', parentId: 'parentId', position: 'position', isTrashed: 'isTrashed' });
      const insertedValues = txInsertValues.mock.calls[0][0];
      expect(insertedValues.title).toBe('Source Page (Copy)');
    });

    it('creates page with Untitled (Copy) when title is null', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([mockSourcePage({ title: null })] as never);

      await POST(createRequest(validBody));

      const insertedValues = txInsertValues.mock.calls[0][0];
      expect(insertedValues.title).toBe('Untitled (Copy)');
    });

    it('sets processingStatus to pending for FILE type pages', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([mockSourcePage({ type: 'FILE' })] as never);

      await POST(createRequest(validBody));

      const insertedValues = txInsertValues.mock.calls[0][0];
      expect(insertedValues.processingStatus).toBe('pending');
    });

    it('sets processingStatus to null for non-FILE type pages', async () => {
      await POST(createRequest(validBody));

      const insertedValues = txInsertValues.mock.calls[0][0];
      expect(insertedValues.processingStatus).toBeNull();
    });

    it('copies children recursively when includeChildren is true', async () => {
      // The pre-transaction blocklist screen walks the tree first; the copy only
      // takes children that walk saw.
      vi.mocked(db.query.pages.findMany)
        .mockResolvedValueOnce([mockSourcePage()] as never)
        .mockResolvedValueOnce([{ id: 'child-1', contentHash: null, filePath: null }] as never)
        .mockResolvedValue([] as never);
      txQueryPagesFindMany
        .mockResolvedValueOnce([
          {
            id: 'child-1', title: 'Child', type: 'DOCUMENT', content: '', position: 1,
            isTrashed: false, aiProvider: null, aiModel: null, systemPrompt: null,
            enabledTools: null, isPaginated: null, includeDrivePrompt: null,
            agentDefinition: null, visibleToGlobalAssistant: null, includePageTree: null,
            pageTreeScope: null, fileSize: null, mimeType: null, originalFileName: null,
            filePath: null, fileMetadata: null, extractionMethod: null,
            extractionMetadata: null, contentHash: null,
          },
        ])
        .mockResolvedValue([]);

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.copiedCount).toBe(2);
    });

    it('does not copy children when includeChildren is false', async () => {
      const response = await POST(createRequest({ ...validBody, includeChildren: false }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.copiedCount).toBe(1);
      expect(txQueryPagesFindMany).not.toHaveBeenCalled();
    });

    it('handles multiple source pages', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockSourcePage({ id: 'page-1' }),
        mockSourcePage({ id: 'page-2', title: 'Page Two' }),
      ] as never);
      vi.mocked(createId).mockReturnValueOnce('new-1').mockReturnValueOnce('new-2');

      const response = await POST(createRequest({
        ...validBody,
        pageIds: ['page-1', 'page-2'],
        includeChildren: false,
      }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.copiedCount).toBe(2);
    });

    it('positions copied pages after the last existing page', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ position: 10 } as never);

      await POST(createRequest({ ...validBody, includeChildren: false }));

      const insertedValues = txInsertValues.mock.calls[0][0];
      expect(insertedValues.position).toBe(11);
    });

    it('starts at position 1 when no existing pages', async () => {
      // findFirst for lastPage returns undefined (no pages exist)
      // But findFirst is also used for targetParent (not called since targetParentId is null)
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

      await POST(createRequest({ ...validBody, includeChildren: false }));

      const insertedValues = txInsertValues.mock.calls[0][0];
      expect(insertedValues.position).toBe(1);
    });
  });

  // ── Side effects ────────────────────────────────────────────────────

  describe('side effects', () => {
    it('broadcasts page created event', async () => {
      await POST(createRequest(validBody));

      expect(broadcastPageEvent).toHaveBeenCalledWith(
        expect.objectContaining({ driveId: mockDriveId })
      );
    });

    it('logs activity for each copied page', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        mockSourcePage({ id: 'page-1', title: 'Page One' }),
        mockSourcePage({ id: 'page-2', title: 'Page Two' }),
      ] as never);
      vi.mocked(createId).mockReturnValueOnce('new-1').mockReturnValueOnce('new-2');

      await POST(createRequest({
        ...validBody,
        pageIds: ['page-1', 'page-2'],
        includeChildren: false,
      }));

      expect(logPageActivity).toHaveBeenCalledTimes(2);
    });

    it('includes MCP source in activity metadata when MCP auth', async () => {
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      await POST(createRequest({ ...validBody, includeChildren: false }));

      expect(logPageActivity).toHaveBeenCalledWith(
        mockUserId,
        'create',
        expect.objectContaining({ driveId: mockDriveId }),
        expect.objectContaining({
          metadata: expect.objectContaining({ source: 'mcp' }),
        }),
      );
    });

    it('does not include MCP source for session auth', async () => {
      await POST(createRequest({ ...validBody, includeChildren: false }));

      const call = vi.mocked(logPageActivity).mock.calls[0];
      const opts = call[3] as { metadata: Record<string, unknown> };
      expect(opts.metadata.source).toBeUndefined();
    });

  });

  // ── Error handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns 500 when transaction throws', async () => {
      mockTransaction.mockRejectedValueOnce(new Error('Database error'));

      const response = await POST(createRequest(validBody));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed.*copy/i);
    });
  });
});

describe('POST /api/pages/bulk-copy — content blocklist', () => {
  const BLOCKED_HASH = 'ab'.repeat(32);
  const filePage = (overrides: Record<string, unknown> = {}) =>
    mockSourcePage({ type: 'FILE', filePath: BLOCKED_HASH, contentHash: BLOCKED_HASH, ...overrides });

  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessScenario();
  });

  const COPY_REFUSED = { error: "One or more files can't be copied" };
  const gateContext = (request: Request) => ({
    entryPoint: 'page.copy',
    userId: mockUserId,
    request,
    details: { driveId: mockDriveId },
  });
  /** Source fetch returns `top`; the pre-transaction tree walk then returns each level in turn. */
  const mockTree = (top: unknown[], ...levels: unknown[][]) => {
    const findMany = vi.mocked(db.query.pages.findMany);
    findMany.mockReset();
    findMany.mockResolvedValueOnce(top as never);
    for (const level of levels) findMany.mockResolvedValueOnce(level as never);
    findMany.mockResolvedValue([] as never);
  };

  it('refuses to copy a page whose content hash is blocked, with a neutral 422 and no transaction', async () => {
    mockTree([filePage()]);
    mockFindBlockedUploads.mockResolvedValue(new Set([BLOCKED_HASH]));

    const response = await POST(createRequest(validBody));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(COPY_REFUSED);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(txInsertValues).not.toHaveBeenCalled();
  });

  it('records the attempt against the user, the request and the target drive', async () => {
    mockTree([filePage()]);
    const request = createRequest(validBody);

    await POST(request);

    expect(mockFindBlockedUploads).toHaveBeenCalledWith([BLOCKED_HASH], gateContext(request));
  });

  it('checks the whole tree in ONE blocklist call before the transaction opens', async () => {
    const CHILD_HASH = 'cd'.repeat(32);
    const GRANDCHILD_HASH = 'ef'.repeat(32);
    mockTree(
      [filePage()],
      [filePage({ id: 'child-1', filePath: CHILD_HASH, contentHash: CHILD_HASH })],
      [filePage({ id: 'grandchild-1', filePath: GRANDCHILD_HASH, contentHash: GRANDCHILD_HASH })],
    );
    mockFindBlockedUploads.mockImplementation(async () => {
      expect(mockTransaction).not.toHaveBeenCalled();
      return new Set();
    });
    const request = createRequest(validBody);

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockFindBlockedUploads).toHaveBeenCalledTimes(1);
    expect(mockFindBlockedUploads).toHaveBeenCalledWith([BLOCKED_HASH, CHILD_HASH, GRANDCHILD_HASH], gateContext(request));
  });

  it('refuses when a DESCENDANT carries a blocked hash, before anything is written', async () => {
    mockTree([mockSourcePage()], [filePage({ id: 'child-1' })]);
    mockFindBlockedUploads.mockResolvedValue(new Set([BLOCKED_HASH]));

    const response = await POST(createRequest(validBody));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(COPY_REFUSED);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('does not walk descendants when includeChildren is false', async () => {
    mockTree([mockSourcePage()], [filePage({ id: 'child-1' })]);

    await POST(createRequest({ ...validBody, includeChildren: false }));

    expect(db.query.pages.findMany).toHaveBeenCalledTimes(1);
    expect(mockFindBlockedUploads).not.toHaveBeenCalled();
  });

  it('resolves a legacy files/<hash>/original filePath to its hash', async () => {
    mockTree([filePage({ filePath: `files/${BLOCKED_HASH.toUpperCase()}/original`, contentHash: null })]);
    mockFindBlockedUploads.mockResolvedValue(new Set([BLOCKED_HASH]));
    const request = createRequest(validBody);

    const response = await POST(request);

    expect(response.status).toBe(422);
    expect(mockFindBlockedUploads).toHaveBeenCalledWith([BLOCKED_HASH], gateContext(request));
  });

  it('fails closed and audits when a filePath cannot be resolved to a content hash', async () => {
    mockTree([mockSourcePage()], [filePage({ id: 'child-1', filePath: 'uploads/2021/cat.png', contentHash: null })]);
    const request = createRequest(validBody);

    const response = await POST(request);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(COPY_REFUSED);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(request, {
      eventType: 'content.upload.blocked',
      userId: mockUserId,
      resourceType: 'page',
      resourceId: 'child-1',
      riskScore: 0.5,
      details: { driveId: mockDriveId, entryPoint: 'page.copy', reason: 'unverifiable_file_reference' },
    });
  });

  it('does not copy a child that appeared after the blocklist screen ran', async () => {
    mockTree([mockSourcePage()]);
    txQueryPagesFindMany.mockResolvedValueOnce([filePage({ id: 'late-child' })]).mockResolvedValue([]);

    const response = await POST(createRequest(validBody));

    expect(response.status).toBe(200);
    expect((await response.json()).copiedCount).toBe(1);
    expect(txInsertValues).toHaveBeenCalledTimes(1);
  });

  it("aborts the copy with a 409 when a screened child's file reference changed before the transaction read it", async () => {
    const CLEAN_HASH = 'cd'.repeat(32);
    // The screen sees child-1 pointing at a clean hash...
    mockTree([mockSourcePage()], [{ id: 'child-1', contentHash: CLEAN_HASH, filePath: CLEAN_HASH }]);
    // ...but by the time the transaction reads it, the same id points at the blocked hash.
    txQueryPagesFindMany.mockResolvedValueOnce([filePage({ id: 'child-1' })]).mockResolvedValue([]);

    const response = await POST(createRequest(validBody));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Some pages changed while they were being copied. Please try again.' });
    // The changed child is never inserted: only the top-level page was, before
    // the throw that (in the real transaction) rolls it back.
    expect(txInsertValues).toHaveBeenCalledTimes(1);
  });

  it('copies a screened child whose file reference is unchanged', async () => {
    const CLEAN_HASH = 'cd'.repeat(32);
    mockTree([mockSourcePage()], [{ id: 'child-1', contentHash: CLEAN_HASH, filePath: CLEAN_HASH }]);
    txQueryPagesFindMany.mockResolvedValueOnce([filePage({ id: 'child-1', contentHash: CLEAN_HASH, filePath: CLEAN_HASH })]).mockResolvedValue([]);

    const response = await POST(createRequest(validBody));

    expect(response.status).toBe(200);
    expect((await response.json()).copiedCount).toBe(2);
  });

  describe('files embedded in document and canvas content', () => {
    const CLEAN_HASH = 'cd'.repeat(32);
    beforeEach(() => {
      mockLoadFileStoragePaths.mockResolvedValue(new Map());
    });

    it('refuses a DOCUMENT whose content embeds a FILE page with a blocked hash, before the transaction', async () => {
      // source fetch → tree walk (no children) → the referenced pages
      mockTree(
        [mockSourcePage({ content: '<p><img src="/api/files/file-page-1/view"></p>' })],
        [],
        [{ id: 'file-page-1', filePath: BLOCKED_HASH, contentHash: BLOCKED_HASH }],
      );
      mockFindBlockedUploads.mockResolvedValue(new Set([BLOCKED_HASH]));
      const request = createRequest(validBody);

      const response = await POST(request);

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual(COPY_REFUSED);
      expect(mockFindBlockedUploads).toHaveBeenCalledWith([BLOCKED_HASH], gateContext(request));
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('refuses an embedded reference written with a trailing slash the same way', async () => {
      mockTree(
        [mockSourcePage({ content: '<img src="/api/files/file-page-1/view/">' })],
        [],
        [{ id: 'file-page-1', filePath: BLOCKED_HASH, contentHash: BLOCKED_HASH }],
      );
      mockFindBlockedUploads.mockResolvedValue(new Set([BLOCKED_HASH]));

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(422);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('resolves an embedded channel/DM attachment through its files row, in the same single blocklist call', async () => {
      mockTree(
        [mockSourcePage({ type: 'CANVAS', content: "<div style=\"background:url('/api/files/att-1/view')\"></div>", filePath: CLEAN_HASH, contentHash: null })],
        [],
        [],
      );
      mockLoadFileStoragePaths.mockResolvedValue(new Map([['att-1', `files/${BLOCKED_HASH}/original`]]));
      mockFindBlockedUploads.mockResolvedValue(new Set([BLOCKED_HASH]));

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(422);
      expect(mockLoadFileStoragePaths).toHaveBeenCalledWith(['att-1']);
      expect(mockFindBlockedUploads).toHaveBeenCalledTimes(1);
      expect([...mockFindBlockedUploads.mock.calls[0][0]].sort()).toEqual([BLOCKED_HASH, CLEAN_HASH].sort());
    });

    it('fails closed and audits when an embedded page has a file reference that cannot be resolved', async () => {
      mockTree(
        [mockSourcePage({ content: '![x](/api/files/legacy-1/view)' })],
        [],
        [{ id: 'legacy-1', filePath: 'uploads/2021/cat.png', contentHash: null }],
      );
      const request = createRequest(validBody);

      const response = await POST(request);

      expect(response.status).toBe(422);
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(auditRequest).toHaveBeenCalledWith(request, expect.objectContaining({
        resourceType: 'file',
        resourceId: 'legacy-1',
        details: expect.objectContaining({ entryPoint: 'page.copy', reason: 'unverifiable_file_reference', pageId: 'page-1' }),
      }));
    });

    it('refuses an embedded reference split by a tab character reference (the URL parser strips it)', async () => {
      mockTree(
        [mockSourcePage({ content: '<img src="/api/files/file-&#9;page-1/vi&#10;ew">' })],
        [],
        [{ id: 'file-page-1', filePath: BLOCKED_HASH, contentHash: BLOCKED_HASH }],
      );
      mockFindBlockedUploads.mockResolvedValue(new Set([BLOCKED_HASH]));

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(422);
      expect(mockFindBlockedUploads).toHaveBeenCalledWith([BLOCKED_HASH], expect.anything());
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('refuses a CANVAS whose style URL splits the reference with a CSS line continuation', async () => {
      mockTree(
        [mockSourcePage({ type: 'CANVAS', content: '<style>.x{background:url("/api/fi\\\nles/file-page-1/view")}</style>' })],
        [],
        [{ id: 'file-page-1', filePath: BLOCKED_HASH, contentHash: BLOCKED_HASH }],
      );
      mockFindBlockedUploads.mockResolvedValue(new Set([BLOCKED_HASH]));

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(422);
      expect(mockFindBlockedUploads).toHaveBeenCalledWith([BLOCKED_HASH], expect.anything());
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('refuses a CANVAS whose script references a blocked file through a dot segment', async () => {
      mockTree(
        [mockSourcePage({ type: 'CANVAS', content: '<script>new Image().src="/api/./files/file-page-1/view"</script>' })],
        [],
        [{ id: 'file-page-1', filePath: BLOCKED_HASH, contentHash: BLOCKED_HASH }],
      );
      mockFindBlockedUploads.mockResolvedValue(new Set([BLOCKED_HASH]));

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(422);
      expect(mockFindBlockedUploads).toHaveBeenCalledWith([BLOCKED_HASH], expect.anything());
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('refuses a CANVAS whose script URL uses escaped slashes, even with parent segments later in the page', async () => {
      mockTree(
        [mockSourcePage({ type: 'CANVAS', content: '<script>new Image().src="/api\\/files\\/file-page-1\\/view"</script><p>/../../../../</p>' })],
        [],
        [{ id: 'file-page-1', filePath: BLOCKED_HASH, contentHash: BLOCKED_HASH }],
      );
      mockFindBlockedUploads.mockResolvedValue(new Set([BLOCKED_HASH]));

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(422);
      expect(mockFindBlockedUploads).toHaveBeenCalledWith([BLOCKED_HASH], expect.anything());
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('fails closed and audits when content mentions api/files/ in a form the scan cannot account for', async () => {
      mockTree([mockSourcePage({ content: '<img src="/api/files/file-&#8203;page-1/view">' })], [], []);
      const request = createRequest(validBody);

      const response = await POST(request);

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual(COPY_REFUSED);
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(auditRequest).toHaveBeenCalledWith(request, expect.objectContaining({
        resourceType: 'page',
        resourceId: 'page-1',
        details: expect.objectContaining({ entryPoint: 'page.copy', reason: 'unverifiable_file_reference', unaccountedReference: true }),
      }));
    });

    it('copies a DOCUMENT whose embedded reference points at nothing stored (no bytes to serve)', async () => {
      mockTree([mockSourcePage({ content: '<img src="/api/files/gone-1/view">' })], [], []);

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(200);
      expect(mockFindBlockedUploads).not.toHaveBeenCalled();
    });

    it('does not parse content of page types that cannot embed files', async () => {
      mockTree([mockSourcePage({ type: 'AI_CHAT', content: '/api/files/file-page-1/view' })], []);

      await POST(createRequest(validBody));

      expect(mockLoadFileStoragePaths).not.toHaveBeenCalled();
      expect(vi.mocked(db.query.pages.findMany)).toHaveBeenCalledTimes(2);
    });

    it("aborts with a 409 when a child document's content gained an embedded file after the screen", async () => {
      mockTree([mockSourcePage()], [{ id: 'child-1', type: 'DOCUMENT', content: '<p>plain</p>', contentHash: null, filePath: null }]);
      txQueryPagesFindMany
        .mockResolvedValueOnce([mockSourcePage({ id: 'child-1', content: '<img src="/api/files/file-page-1/view">' })])
        .mockResolvedValue([]);

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(409);
      expect(txInsertValues).toHaveBeenCalledTimes(1);
    });

    it("aborts with a 409 when a child document's content gained an unaccountable api/files/ mention after the screen", async () => {
      mockTree([mockSourcePage()], [{ id: 'child-1', type: 'DOCUMENT', content: '<p>plain</p>', contentHash: null, filePath: null }]);
      txQueryPagesFindMany
        .mockResolvedValueOnce([mockSourcePage({ id: 'child-1', content: '<p>/api/ files/file-page-1/view</p>' })])
        .mockResolvedValue([]);

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(409);
    });

    it('copies a child document whose embedded files are unchanged since the screen', async () => {
      const content = '<img src="/api/files/file-page-1/view">';
      mockTree(
        [mockSourcePage()],
        [{ id: 'child-1', type: 'DOCUMENT', content, contentHash: null, filePath: null }],
        [],
        [{ id: 'file-page-1', filePath: CLEAN_HASH, contentHash: CLEAN_HASH }],
      );
      txQueryPagesFindMany.mockResolvedValueOnce([mockSourcePage({ id: 'child-1', content: `${content}<p>edited text</p>` })]).mockResolvedValue([]);

      const response = await POST(createRequest(validBody));

      expect(response.status).toBe(200);
      expect((await response.json()).copiedCount).toBe(2);
    });
  });

  it('still copies a selected page inside its selected ancestor', async () => {
    // page-1 and its child page-2 are both selected: page-2 is copied under
    // page-1's copy and once more at the top level.
    mockTree([mockSourcePage({ id: 'page-1' }), mockSourcePage({ id: 'page-2' })], [{ id: 'page-2', contentHash: null, filePath: null }]);
    txQueryPagesFindMany.mockResolvedValueOnce([mockSourcePage({ id: 'page-2' })]).mockResolvedValue([]);

    const response = await POST(createRequest({ ...validBody, pageIds: ['page-1', 'page-2'] }));

    expect(response.status).toBe(200);
    expect((await response.json()).copiedCount).toBe(3);
  });

  it('does not query the blocklist when no copied page carries a hash', async () => {
    await POST(createRequest(validBody));

    expect(mockFindBlockedUploads).not.toHaveBeenCalled();
  });

  it('copies a file page whose hash is not blocked', async () => {
    mockTree([filePage()]);

    const response = await POST(createRequest(validBody));

    expect(response.status).toBe(200);
    expect(txInsertValues.mock.calls[0][0].contentHash).toBe(BLOCKED_HASH);
  });
});
