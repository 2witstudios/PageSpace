import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/backups/schedule
// Mocks at the service seam level.
// ============================================================================

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isDriveOwnerOrAdmin: vi.fn(),
}));

vi.mock('@/lib/workflows/cron-utils', () => ({
  validateTimezone: vi.fn(() => ({ valid: true })),
}));

const {
  mockOnConflictDoUpdate,
  mockValues,
  mockInsert,
  mockLimit,
  mockFrom,
} = vi.hoisted(() => {
  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockValues = vi.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
  const mockInsert = vi.fn(() => ({ values: mockValues }));
  const mockLimit = vi.fn();
  // mockWhere and mockInnerJoin are internal to the select chain — no direct test refs
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockInnerJoin = vi.fn(() => ({ where: mockWhere }));
  const mockFrom = vi.fn(() => ({ where: mockWhere, innerJoin: mockInnerJoin }));
  return { mockOnConflictDoUpdate, mockValues, mockInsert, mockLimit, mockFrom };
});

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({ from: mockFrom })),
    insert: mockInsert,
  },
}));

vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@pagespace/db/schema/core', () => ({ drives: {} }));
vi.mock('@pagespace/db/schema/versioning', () => ({ driveBackupSchedules: {} }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));

import { GET, PATCH } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { validateTimezone } from '@/lib/workflows/cron-utils';

// ============================================================================
// Helpers
// ============================================================================

const mockAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess_1',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
});

const ctx = (driveId: string) => ({ params: Promise.resolve({ driveId }) });

const USER_ID = 'user_1';
const DRIVE_ID = 'drive_1';

// ============================================================================
// GET /api/drives/[driveId]/backups/schedule
// ============================================================================

describe('GET /api/drives/[driveId]/backups/schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth(USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    // Default: pro tier, no schedule row
    mockLimit
      .mockResolvedValueOnce([{ tier: 'pro' }])  // user tier query
      .mockResolvedValueOnce([]);                  // schedule query
  });

  const req = () => new Request(`https://x.com/api/drives/${DRIVE_ID}/backups/schedule`);

  describe('authentication', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError());

      const res = await GET(req(), ctx(DRIVE_ID));
      expect(res.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('returns 403 for non-owner/non-admin', async () => {
      vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);

      const res = await GET(req(), ctx(DRIVE_ID));
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.error).toMatch(/owner/i);
    });
  });

  describe('response — no existing schedule row', () => {
    it('returns available:true + defaults for pro+ tier', async () => {
      const res = await GET(req(), ctx(DRIVE_ID));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({
        available: true,
        enabled: false,
        frequency: 'daily',
        timezone: 'UTC',
        nextRunAt: null,
        lastRunAt: null,
      });
    });

    it('returns available:false for free tier', async () => {
      mockLimit.mockReset();
      mockLimit
        .mockResolvedValueOnce([{ tier: 'free' }])
        .mockResolvedValueOnce([]);

      const res = await GET(req(), ctx(DRIVE_ID));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.available).toBe(false);
      expect(body.enabled).toBe(false);
    });

    it('returns available:true for founder tier', async () => {
      mockLimit.mockReset();
      mockLimit
        .mockResolvedValueOnce([{ tier: 'founder' }])
        .mockResolvedValueOnce([]);

      const res = await GET(req(), ctx(DRIVE_ID));
      const body = await res.json();

      expect(body.available).toBe(true);
    });

    it('returns available:true for business tier', async () => {
      mockLimit.mockReset();
      mockLimit
        .mockResolvedValueOnce([{ tier: 'business' }])
        .mockResolvedValueOnce([]);

      const res = await GET(req(), ctx(DRIVE_ID));
      const body = await res.json();

      expect(body.available).toBe(true);
    });
  });

  describe('response — existing schedule row', () => {
    it('returns the row values plus available', async () => {
      const nextRunAt = new Date('2026-06-10T12:00:00.000Z');
      const lastRunAt = new Date('2026-06-09T12:00:00.000Z');

      mockLimit.mockReset();
      mockLimit
        .mockResolvedValueOnce([{ tier: 'pro' }])
        .mockResolvedValueOnce([{
          enabled: true,
          frequency: 'weekly',
          timezone: 'America/New_York',
          nextRunAt,
          lastRunAt,
        }]);

      const res = await GET(req(), ctx(DRIVE_ID));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.available).toBe(true);
      expect(body.enabled).toBe(true);
      expect(body.frequency).toBe('weekly');
      expect(body.timezone).toBe('America/New_York');
      expect(body.nextRunAt).toBe(nextRunAt.toISOString());
      expect(body.lastRunAt).toBe(lastRunAt.toISOString());
    });
  });

  describe('parallel db queries', () => {
    it('calls db.select three times (isDriveOwnerOrAdmin + tier + schedule) via Promise.all', async () => {
      await GET(req(), ctx(DRIVE_ID));
      // isDriveOwnerOrAdmin is mocked separately; db.select covers tier + schedule
      expect(db.select).toHaveBeenCalledTimes(2);
      expect(isDriveOwnerOrAdmin).toHaveBeenCalledWith(USER_ID, DRIVE_ID);
    });
  });

  describe('owner tier vs caller tier', () => {
    it('returns available:false when drive owner is free-tier even if caller is an admin', async () => {
      // Caller is an admin (isDriveOwnerOrAdmin returns true), but the
      // drive owner has a free subscription — available must reflect the owner.
      mockLimit.mockReset();
      mockLimit
        .mockResolvedValueOnce([{ tier: 'free' }])  // drive owner's tier
        .mockResolvedValueOnce([]);                   // schedule row

      const res = await GET(req(), ctx(DRIVE_ID));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.available).toBe(false);
    });
  });
});

// ============================================================================
// PATCH /api/drives/[driveId]/backups/schedule
// ============================================================================

describe('PATCH /api/drives/[driveId]/backups/schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // mockResolvedValueOnce values survive vi.clearAllMocks() — reset the queue explicitly
    mockLimit.mockReset();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth(USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    vi.mocked(validateTimezone).mockReturnValue({ valid: true });
    mockOnConflictDoUpdate.mockResolvedValue(undefined);
    // Default: pro tier, no existing schedule row
    mockLimit
      .mockResolvedValueOnce([{ tier: 'pro' }])
      .mockResolvedValueOnce([]);
  });

  const patchReq = (body: object) =>
    new Request(`https://x.com/api/drives/${DRIVE_ID}/backups/schedule`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  describe('authentication', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError());

      const res = await PATCH(patchReq({ enabled: true }), ctx(DRIVE_ID));
      expect(res.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('returns 403 for non-owner/non-admin', async () => {
      vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);

      const res = await PATCH(patchReq({ enabled: true }), ctx(DRIVE_ID));
      expect(res.status).toBe(403);
    });
  });

  describe('tier enforcement', () => {
    it('returns 402 with pro_required for free-tier user', async () => {
      mockLimit.mockReset();
      mockLimit.mockResolvedValueOnce([{ tier: 'free' }]);

      const res = await PATCH(patchReq({ enabled: true }), ctx(DRIVE_ID));
      const body = await res.json();

      expect(res.status).toBe(402);
      expect(body.error).toBe('pro_required');
    });

    it('returns 402 when caller is admin but drive owner is free-tier', async () => {
      // ADMIN collaborator (isDriveOwnerOrAdmin = true) tries to enable a
      // schedule on a drive whose owner has a free subscription.
      // The gate must use the owner's tier, not the caller's.
      mockLimit.mockReset();
      mockLimit.mockResolvedValueOnce([{ tier: 'free' }]);

      const res = await PATCH(patchReq({ enabled: true }), ctx(DRIVE_ID));
      const body = await res.json();

      expect(res.status).toBe(402);
      expect(body.error).toBe('pro_required');
    });
  });

  describe('timezone validation', () => {
    it('returns 400 for invalid timezone', async () => {
      vi.mocked(validateTimezone).mockReturnValue({ valid: false, error: 'Invalid timezone' });

      const res = await PATCH(patchReq({ enabled: true, timezone: 'Invalid/Zone' }), ctx(DRIVE_ID));
      expect(res.status).toBe(400);
    });
  });

  describe('successful upsert', () => {
    it('returns enabled:true with nextRunAt ~24h from now for daily frequency', async () => {
      const before = Date.now();
      const res = await PATCH(patchReq({ enabled: true, frequency: 'daily' }), ctx(DRIVE_ID));
      const after = Date.now();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.enabled).toBe(true);
      expect(body.frequency).toBe('daily');
      expect(body.nextRunAt).not.toBeNull();

      const nextRun = new Date(body.nextRunAt).getTime();
      expect(nextRun).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1000);
      expect(nextRun).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 1000);
    });

    it('returns nextRunAt:null when enabled:false', async () => {
      const res = await PATCH(patchReq({ enabled: false }), ctx(DRIVE_ID));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.enabled).toBe(false);
      expect(body.nextRunAt).toBeNull();
    });

    it('persists provided timezone in response', async () => {
      const res = await PATCH(
        patchReq({ enabled: true, timezone: 'America/New_York' }),
        ctx(DRIVE_ID)
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.timezone).toBe('America/New_York');
    });

    it('preserves existing frequency when not provided in body', async () => {
      mockLimit.mockReset();
      mockLimit
        .mockResolvedValueOnce([{ tier: 'pro' }])
        .mockResolvedValueOnce([{ frequency: 'weekly', timezone: 'UTC' }]);

      const res = await PATCH(patchReq({ enabled: true }), ctx(DRIVE_ID));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.frequency).toBe('weekly');
    });

    it('preserves existing timezone when not provided in body', async () => {
      mockLimit.mockReset();
      mockLimit
        .mockResolvedValueOnce([{ tier: 'pro' }])
        .mockResolvedValueOnce([{ frequency: 'daily', timezone: 'Europe/London' }]);

      const res = await PATCH(patchReq({ enabled: true }), ctx(DRIVE_ID));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.timezone).toBe('Europe/London');
    });

    it('uses onConflictDoUpdate — does not insert a second row', async () => {
      await PATCH(patchReq({ enabled: true, frequency: 'daily' }), ctx(DRIVE_ID));

      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockValues).toHaveBeenCalledTimes(1);
      expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    });
  });
});
