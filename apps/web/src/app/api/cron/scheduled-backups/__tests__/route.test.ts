import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/cron/scheduled-backups
// Mocks at the service seam level.
// ============================================================================

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    system: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(() => null),
}));

vi.mock('@/services/api/drive-backup-service', () => ({
  createDriveBackup: vi.fn().mockResolvedValue({ success: true }),
}));

// Only destructure what's actually referenced outside the hoisted block.
// mockWhere/mockInnerJoin/mockFrom/mockOrderBy stay internal — they build the
// select chain and are captured by closure; no need to expose them.
const { mockLimit, mockSelect, mockUpdate, mockUpdateWhere, mockSet } =
  vi.hoisted(() => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
    const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
    const mockInnerJoin = vi.fn();
    const chainable = { where: mockWhere, innerJoin: mockInnerJoin };
    mockInnerJoin.mockReturnValue(chainable);
    const mockFrom = vi.fn(() => chainable);
    const mockSelect = vi.fn(() => ({ from: mockFrom }));

    const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn(() => ({ where: mockUpdateWhere }));
    const mockUpdate = vi.fn(() => ({ set: mockSet }));

    return { mockLimit, mockSelect, mockUpdate, mockUpdateWhere, mockSet };
  });

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
  },
}));

vi.mock('@pagespace/db/schema/versioning', () => ({
  driveBackupSchedules: {},
  driveBackupScheduleFrequencyEnum: {},
}));
vi.mock('@pagespace/db/schema/core', () => ({ drives: {} }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  lte: vi.fn(),
  asc: vi.fn(),
}));

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { createDriveBackup } from '@/services/api/drive-backup-service';

// ============================================================================
// Helpers
// ============================================================================

const req = () => new Request('https://x.com/api/cron/scheduled-backups');

type ScheduleRow = {
  id: string;
  driveId: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  nextRunAt: Date | null;
  ownerId: string;
  ownerTier: string;
};

const makeSchedule = (overrides: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: 'sched_1',
  driveId: 'drive_1',
  frequency: 'daily',
  nextRunAt: null,
  ownerId: 'user_1',
  ownerTier: 'pro',
  ...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/cron/scheduled-backups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockReset();
    mockLimit.mockResolvedValue([]);
    mockUpdateWhere.mockResolvedValue(undefined);
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    vi.mocked(createDriveBackup).mockResolvedValue({ success: true } as never);
  });

  describe('authentication', () => {
    it('returns 403 when HMAC validation fails', async () => {
      vi.mocked(validateSignedCronRequest).mockReturnValue(
        NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      );

      const res = await GET(req());
      expect(res.status).toBe(403);
    });
  });

  describe('no due schedules', () => {
    it('returns { success: true, fired: 0, skipped: 0 }', async () => {
      mockLimit.mockResolvedValue([]);

      const res = await GET(req());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ success: true, fired: 0, skipped: 0 });
    });
  });

  describe('pro+ drive owner', () => {
    it('calls createDriveBackup with source scheduled and increments fired', async () => {
      const schedule = makeSchedule({ ownerTier: 'pro' });
      mockLimit.mockResolvedValueOnce([schedule]).mockResolvedValue([]);

      const res = await GET(req());
      const body = await res.json();

      expect(createDriveBackup).toHaveBeenCalledWith(
        schedule.driveId,
        schedule.ownerId,
        { source: 'scheduled' }
      );
      expect(res.status).toBe(200);
      expect(body.fired).toBe(1);
      expect(body.skipped).toBe(0);
    });

    it('updates lastRunAt and advances nextRunAt for daily frequency', async () => {
      const schedule = makeSchedule({ frequency: 'daily' });
      mockLimit.mockResolvedValueOnce([schedule]).mockResolvedValue([]);

      const before = Date.now();
      await GET(req());
      const after = Date.now();

      expect(mockSet).toHaveBeenCalledTimes(1);
      const setArg = (vi.mocked(mockSet).mock.calls as unknown[][])[0][0] as Record<string, unknown>;

      expect(setArg.lastRunAt).toBeInstanceOf(Date);
      expect(setArg.nextRunAt).toBeInstanceOf(Date);

      const nextRun = (setArg.nextRunAt as Date).getTime();
      expect(nextRun).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1000);
      expect(nextRun).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 1000);
    });

    it('advances nextRunAt by 7 days for weekly frequency', async () => {
      const schedule = makeSchedule({ frequency: 'weekly' });
      mockLimit.mockResolvedValueOnce([schedule]).mockResolvedValue([]);

      const before = Date.now();
      await GET(req());
      const after = Date.now();

      const setArg = (vi.mocked(mockSet).mock.calls as unknown[][])[0][0] as Record<string, unknown>;
      const nextRun = (setArg.nextRunAt as Date).getTime();
      expect(nextRun).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1000 - 1000);
      expect(nextRun).toBeLessThanOrEqual(after + 7 * 24 * 60 * 60 * 1000 + 1000);
    });

    it('advances nextRunAt by ~1 month for monthly frequency', async () => {
      // Freeze time to a mid-month date to make the assertion deterministic
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-15T12:00:00.000Z'));

      const prevNextRunAt = new Date('2026-03-15T12:00:00.000Z');
      const schedule = makeSchedule({ frequency: 'monthly', nextRunAt: prevNextRunAt });
      mockLimit.mockResolvedValueOnce([schedule]).mockResolvedValue([]);

      await GET(req());

      vi.useRealTimers();

      const setArg = (vi.mocked(mockSet).mock.calls as unknown[][])[0][0] as Record<string, unknown>;
      const nextRun = setArg.nextRunAt as Date;

      // Should advance from March 15 to April 15
      expect(nextRun.getUTCFullYear()).toBe(2026);
      expect(nextRun.getUTCMonth()).toBe(3); // April = 3
      expect(nextRun.getUTCDate()).toBe(15);
    });

    it('advances nextRunAt from schedule.nextRunAt (not wall-clock now) to preserve cadence', async () => {
      // Schedule was due at 2am; cron fires 3 hours late at 5am
      const scheduledTime = new Date('2026-06-10T02:00:00.000Z');
      const schedule = makeSchedule({ frequency: 'daily', nextRunAt: scheduledTime });
      mockLimit.mockResolvedValueOnce([schedule]).mockResolvedValue([]);

      await GET(req());

      const setArg = (vi.mocked(mockSet).mock.calls as unknown[][])[0][0] as Record<string, unknown>;
      const nextRun = setArg.nextRunAt as Date;

      // Next run should be exactly 1 day after the scheduled time (not after now)
      expect(nextRun.getTime()).toBe(scheduledTime.getTime() + 24 * 60 * 60 * 1000);
    });
  });

  describe('free-tier drive owner (tier downgrade)', () => {
    it('does not call createDriveBackup and increments skipped', async () => {
      const schedule = makeSchedule({ ownerTier: 'free' });
      mockLimit.mockResolvedValueOnce([schedule]).mockResolvedValue([]);

      const res = await GET(req());
      const body = await res.json();

      expect(createDriveBackup).not.toHaveBeenCalled();
      expect(body.skipped).toBe(1);
      expect(body.fired).toBe(0);
    });

    it('still advances nextRunAt on skip', async () => {
      const schedule = makeSchedule({ ownerTier: 'free' });
      mockLimit.mockResolvedValueOnce([schedule]).mockResolvedValue([]);

      await GET(req());

      expect(mockSet).toHaveBeenCalledTimes(1);
      const setArg = (vi.mocked(mockSet).mock.calls as unknown[][])[0][0] as Record<string, unknown>;
      expect(setArg.nextRunAt).toBeInstanceOf(Date);
    });
  });

  describe('createDriveBackup failure cases', () => {
    it('increments skipped and still advances nextRunAt when backup returns { success: false }', async () => {
      vi.mocked(createDriveBackup).mockResolvedValue({ success: false } as never);
      const schedule = makeSchedule();
      mockLimit.mockResolvedValueOnce([schedule]).mockResolvedValue([]);

      const res = await GET(req());
      const body = await res.json();

      expect(body.skipped).toBe(1);
      expect(body.fired).toBe(0);
      expect(mockSet).toHaveBeenCalledTimes(1);
    });

    it('catches thrown errors, still advances nextRunAt, never crashes cron', async () => {
      vi.mocked(createDriveBackup).mockRejectedValue(new Error('backup exploded'));
      const schedule = makeSchedule();
      mockLimit.mockResolvedValueOnce([schedule]).mockResolvedValue([]);

      const res = await GET(req());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.skipped).toBe(1);
      expect(body.fired).toBe(0);
      expect(mockSet).toHaveBeenCalledTimes(1);
    });
  });

  describe('batch processing', () => {
    it('processes multiple due schedules and aggregates counts', async () => {
      const schedules = [
        makeSchedule({ id: 's1', driveId: 'd1', ownerId: 'u1', ownerTier: 'pro' }),
        makeSchedule({ id: 's2', driveId: 'd2', ownerId: 'u2', ownerTier: 'free' }),
        makeSchedule({ id: 's3', driveId: 'd3', ownerId: 'u3', ownerTier: 'pro' }),
      ];
      mockLimit.mockResolvedValueOnce(schedules).mockResolvedValue([]);

      const res = await GET(req());
      const body = await res.json();

      expect(body.fired).toBe(2);
      expect(body.skipped).toBe(1);
      expect(createDriveBackup).toHaveBeenCalledTimes(2);
      expect(mockSet).toHaveBeenCalledTimes(3);
    });
  });
});
