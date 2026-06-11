import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before any imports from the module under test
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), delete: vi.fn() },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a: unknown, _b: unknown) => 'eq'),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  inArray: vi.fn((_a: unknown, _b: unknown) => 'inArray'),
  isNotNull: vi.fn((_a: unknown) => 'isNotNull'),
}));
vi.mock('@pagespace/db/schema/calendar', () => ({
  calendarEvents: { id: 'ce.id', driveId: 'ce.driveId', createdById: 'ce.createdById', isTrashed: 'ce.isTrashed' },
  calendarEventDrives: { id: 'ced.id', eventId: 'ced.eventId', driveId: 'ced.driveId', sharedBy: 'ced.sharedBy', sharedAt: 'ced.sharedAt' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'drives.id', name: 'drives.name', slug: 'drives.slug' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { driveId: 'dm.driveId', userId: 'dm.userId', acceptedAt: 'dm.acceptedAt' },
}));
vi.mock('../../permissions/permissions', () => ({
  isDriveOwnerOrAdmin: vi.fn(),
  isUserDriveMember: vi.fn(),
}));
vi.mock('../../services/drive-member-service', () => ({
  getDriveMemberUserIds: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  validateShareEventInput,
  validateUnshareEventInput,
  isUserInAnyDriveSet,
  shareEventWithDrive,
  unshareEventFromDrive,
  listEventDrives,
  isUserMemberOfAnyEventDrive,
  getAllMemberUserIdsForEvent,
  getAllDriveIdsForEvent,
} from '../calendar-event-drive-service';
import { db } from '@pagespace/db/db';
import { isDriveOwnerOrAdmin, isUserDriveMember } from '../../permissions/permissions';
import { getDriveMemberUserIds } from '../../services/drive-member-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockDb = { select: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

function stubSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
    }),
  };
}

function stubSelectMany(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
    }),
  };
}

const EVENT_ID = 'evt_aaaaaaaaaaaaaaaaaaaaaaaa';
const HOME_DRIVE = 'drv_home_aaaaaaaaaaaaaaaaaaa';
const SHARED_DRIVE = 'drv_shared_aaaaaaaaaaaaaaa';
const ANOTHER_DRIVE = 'drv_other_aaaaaaaaaaaaaaa';
const USER_ID = 'usr_aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_USER = 'usr_bbbbbbbbbbbbbbbbbbbbbbbb';

const BASE_EVENT = {
  id: EVENT_ID,
  driveId: HOME_DRIVE,
  createdById: USER_ID,
  isTrashed: false,
};

// ---------------------------------------------------------------------------
// Pure function: validateShareEventInput
// ---------------------------------------------------------------------------

describe('validateShareEventInput (pure)', () => {
  const baseInput = {
    actingUserId: USER_ID,
    event: BASE_EVENT,
    targetDriveId: SHARED_DRIVE,
    actingUserIsHomeDriveAdmin: false,
    actingUserIsTargetDriveMember: true,
  };

  it('returns ok:true when caller is event creator + target drive member', () => {
    const result = validateShareEventInput(baseInput);
    expect(result).toEqual({ ok: true });
  });

  it('returns ok:true when caller is home-drive admin (not creator)', () => {
    const result = validateShareEventInput({
      ...baseInput,
      actingUserId: OTHER_USER,
      actingUserIsHomeDriveAdmin: true,
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns 404 when event is trashed', () => {
    const result = validateShareEventInput({
      ...baseInput,
      event: { ...BASE_EVENT, isTrashed: true },
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it('returns 400 when event.driveId is null (personal event)', () => {
    const result = validateShareEventInput({
      ...baseInput,
      event: { ...BASE_EVENT, driveId: null as unknown as string },
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { error: string }).error).toMatch(/personal/i);
  });

  it('returns 400 when targetDriveId === event.driveId (home drive)', () => {
    const result = validateShareEventInput({
      ...baseInput,
      targetDriveId: HOME_DRIVE,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { error: string }).error).toMatch(/home drive/i);
  });

  it('returns 403 when caller is neither creator nor home-drive admin', () => {
    const result = validateShareEventInput({
      ...baseInput,
      actingUserId: OTHER_USER,
      actingUserIsHomeDriveAdmin: false,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('returns 400 when caller is not a member of target drive', () => {
    const result = validateShareEventInput({
      ...baseInput,
      actingUserIsTargetDriveMember: false,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { error: string }).error).toMatch(/not a member/i);
  });
});

// ---------------------------------------------------------------------------
// Pure function: validateUnshareEventInput
// ---------------------------------------------------------------------------

describe('validateUnshareEventInput (pure)', () => {
  const baseInput = {
    actingUserId: USER_ID,
    event: BASE_EVENT,
    targetDriveId: SHARED_DRIVE,
    actingUserIsHomeDriveAdmin: false,
    actingUserIsTargetDriveAdmin: false,
    junctionRowExists: true,
  };

  it('returns ok:true when caller is creator + junction row exists', () => {
    expect(validateUnshareEventInput(baseInput)).toEqual({ ok: true });
  });

  it('returns ok:true when caller is home-drive admin (not creator)', () => {
    expect(validateUnshareEventInput({
      ...baseInput,
      actingUserId: OTHER_USER,
      actingUserIsHomeDriveAdmin: true,
    })).toEqual({ ok: true });
  });

  it('returns ok:true when caller is target-drive admin (not home-drive admin)', () => {
    expect(validateUnshareEventInput({
      ...baseInput,
      actingUserId: OTHER_USER,
      actingUserIsTargetDriveAdmin: true,
    })).toEqual({ ok: true });
  });

  it('returns 404 when event is trashed', () => {
    const result = validateUnshareEventInput({
      ...baseInput,
      event: { ...BASE_EVENT, isTrashed: true },
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it('returns 400 when targetDriveId === event.driveId (home drive)', () => {
    const result = validateUnshareEventInput({
      ...baseInput,
      targetDriveId: HOME_DRIVE,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { error: string }).error).toMatch(/home drive/i);
  });

  it('returns 404 when junction row does not exist', () => {
    const result = validateUnshareEventInput({
      ...baseInput,
      junctionRowExists: false,
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect((result as { error: string }).error).toMatch(/not shared/i);
  });

  it('returns 403 when caller has no management rights', () => {
    const result = validateUnshareEventInput({
      ...baseInput,
      actingUserId: OTHER_USER,
      actingUserIsHomeDriveAdmin: false,
      actingUserIsTargetDriveAdmin: false,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });
});

// ---------------------------------------------------------------------------
// Pure function: isUserInAnyDriveSet
// ---------------------------------------------------------------------------

describe('isUserInAnyDriveSet (pure)', () => {
  it('returns true when userId is in homeDriveMembers', () => {
    expect(isUserInAnyDriveSet(USER_ID, new Set([USER_ID, OTHER_USER]), [])).toBe(true);
  });

  it('returns true when userId is in a shared drive set', () => {
    expect(
      isUserInAnyDriveSet(USER_ID, new Set([OTHER_USER]), [new Set([USER_ID])])
    ).toBe(true);
  });

  it('returns false when userId is in no set', () => {
    expect(
      isUserInAnyDriveSet(USER_ID, new Set([OTHER_USER]), [new Set([OTHER_USER])])
    ).toBe(false);
  });

  it('returns false when all sets are empty', () => {
    expect(isUserInAnyDriveSet(USER_ID, new Set(), [new Set()])).toBe(false);
  });

  it('short-circuits on home drive — does not check shared sets when home match found', () => {
    const shared = new Set<string>();
    const hasSpy = vi.spyOn(shared, 'has');
    isUserInAnyDriveSet(USER_ID, new Set([USER_ID]), [shared]);
    expect(hasSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// shareEventWithDrive (effect + orchestrator)
// ---------------------------------------------------------------------------

describe('shareEventWithDrive', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 201 with row when caller is creator + target drive member', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select
      .mockReturnValueOnce(stubSelect([BASE_EVENT])); // event lookup
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'ced1', eventId: EVENT_ID, driveId: SHARED_DRIVE, sharedBy: USER_ID, sharedAt: new Date() }]),
      }),
    });

    const result = await shareEventWithDrive({ actingUserId: USER_ID, eventId: EVENT_ID, driveId: SHARED_DRIVE });
    expect(result).toMatchObject({ ok: true, status: 201 });
  });

  it('returns 400 when targetDriveId === event home driveId', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValueOnce(stubSelect([BASE_EVENT]));
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);

    const result = await shareEventWithDrive({ actingUserId: USER_ID, eventId: EVENT_ID, driveId: HOME_DRIVE });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { error: string }).error).toMatch(/home drive/i);
  });

  it('returns 400 when event is personal (driveId null)', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValueOnce(stubSelect([{ ...BASE_EVENT, driveId: null }]));
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);

    const result = await shareEventWithDrive({ actingUserId: USER_ID, eventId: EVENT_ID, driveId: SHARED_DRIVE });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { error: string }).error).toMatch(/personal/i);
  });

  it('returns 404 when event not found', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValueOnce(stubSelect([]));

    const result = await shareEventWithDrive({ actingUserId: USER_ID, eventId: EVENT_ID, driveId: SHARED_DRIVE });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it('returns 403 when caller is neither creator nor home-drive admin', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValueOnce(stubSelect([BASE_EVENT]));
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);

    const result = await shareEventWithDrive({ actingUserId: OTHER_USER, eventId: EVENT_ID, driveId: SHARED_DRIVE });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('returns 400 when caller is not a member of target drive', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValueOnce(stubSelect([BASE_EVENT]));
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    vi.mocked(isUserDriveMember).mockResolvedValue(false);

    const result = await shareEventWithDrive({ actingUserId: USER_ID, eventId: EVENT_ID, driveId: SHARED_DRIVE });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { error: string }).error).toMatch(/not a member/i);
  });

  it('returns 409 on duplicate (DB 23505)', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValueOnce(stubSelect([BASE_EVENT]));
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);
    const pgError = Object.assign(new Error('unique'), { code: '23505' });
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(pgError),
      }),
    });

    const result = await shareEventWithDrive({ actingUserId: USER_ID, eventId: EVENT_ID, driveId: SHARED_DRIVE });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toMatch(/already shared/i);
  });
});

// ---------------------------------------------------------------------------
// unshareEventFromDrive (effect + orchestrator)
// ---------------------------------------------------------------------------

describe('unshareEventFromDrive', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('returns 200 when caller is creator + junction row exists', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select
      .mockReturnValueOnce(stubSelect([BASE_EVENT]))
      .mockReturnValueOnce(stubSelect([{ id: 'ced1' }])); // junction row exists
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

    const result = await unshareEventFromDrive({ actingUserId: USER_ID, eventId: EVENT_ID, driveId: SHARED_DRIVE });
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it('returns 400 when targetDriveId === home drive', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValueOnce(stubSelect([BASE_EVENT]));
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);

    const result = await unshareEventFromDrive({ actingUserId: USER_ID, eventId: EVENT_ID, driveId: HOME_DRIVE });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { error: string }).error).toMatch(/home drive/i);
  });

  it('returns 404 when junction row does not exist', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select
      .mockReturnValueOnce(stubSelect([BASE_EVENT]))
      .mockReturnValueOnce(stubSelect([])); // no junction row
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);

    const result = await unshareEventFromDrive({ actingUserId: USER_ID, eventId: EVENT_ID, driveId: SHARED_DRIVE });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it('returns 403 when caller has no rights', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select
      .mockReturnValueOnce(stubSelect([BASE_EVENT]))
      .mockReturnValueOnce(stubSelect([{ id: 'ced1' }]));
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);

    const result = await unshareEventFromDrive({ actingUserId: OTHER_USER, eventId: EVENT_ID, driveId: SHARED_DRIVE });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('returns 404 when event not found', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValueOnce(stubSelect([]));

    const result = await unshareEventFromDrive({ actingUserId: USER_ID, eventId: EVENT_ID, driveId: SHARED_DRIVE });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});

// ---------------------------------------------------------------------------
// listEventDrives
// ---------------------------------------------------------------------------

describe('listEventDrives', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('returns home drive first (isHome:true) then shared drives', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select
      .mockReturnValueOnce(stubSelect([BASE_EVENT]))
      .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: HOME_DRIVE, name: 'Home', slug: 'home' }]) }) }) })
      .mockReturnValueOnce(stubSelectMany([
        { id: 'ced1', driveId: SHARED_DRIVE, sharedBy: OTHER_USER, sharedAt: new Date('2026-01-01'), drive: { id: SHARED_DRIVE, name: 'Shared', slug: 'shared' } },
      ]));

    const result = await listEventDrives(EVENT_ID);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ driveId: HOME_DRIVE, isHome: true, sharedAt: null, sharedBy: null });
    expect(result[1]).toMatchObject({ driveId: SHARED_DRIVE, isHome: false });
  });

  it('returns single entry when no shared drives', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select
      .mockReturnValueOnce(stubSelect([BASE_EVENT]))
      .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: HOME_DRIVE, name: 'Home', slug: 'home' }]) }) }) })
      .mockReturnValueOnce(stubSelectMany([]));

    const result = await listEventDrives(EVENT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].isHome).toBe(true);
  });

  it('returns [] for personal events (driveId null)', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValueOnce(stubSelect([{ ...BASE_EVENT, driveId: null }]));

    const result = await listEventDrives(EVENT_ID);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isUserMemberOfAnyEventDrive
// ---------------------------------------------------------------------------

describe('isUserMemberOfAnyEventDrive', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('returns true without querying junction when user is home-drive member', async () => {
    vi.mocked(getDriveMemberUserIds).mockResolvedValue([USER_ID]);
    const mockDb = db as unknown as MockDb;
    const junctionSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    mockDb.select.mockReturnValue({ from: junctionSpy });

    const result = await isUserMemberOfAnyEventDrive(USER_ID, BASE_EVENT);
    expect(result).toBe(true);
    // junction table should NOT have been queried (fast-path)
    expect(junctionSpy).not.toHaveBeenCalled();
  });

  it('returns true when user is only in a shared drive', async () => {
    vi.mocked(getDriveMemberUserIds)
      .mockResolvedValueOnce([OTHER_USER]) // home drive members
      .mockResolvedValueOnce([USER_ID]);   // shared drive members
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValue(stubSelectMany([{ driveId: SHARED_DRIVE }]));

    const result = await isUserMemberOfAnyEventDrive(USER_ID, BASE_EVENT);
    expect(result).toBe(true);
  });

  it('returns false when user is in neither home nor any shared drive', async () => {
    vi.mocked(getDriveMemberUserIds).mockResolvedValue([OTHER_USER]);
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValue(stubSelectMany([]));

    const result = await isUserMemberOfAnyEventDrive(USER_ID, BASE_EVENT);
    expect(result).toBe(false);
  });

  it('returns false immediately for personal events without any DB calls', async () => {
    const result = await isUserMemberOfAnyEventDrive(USER_ID, { ...BASE_EVENT, driveId: null as unknown as string });
    expect(result).toBe(false);
    expect(getDriveMemberUserIds).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getAllMemberUserIdsForEvent
// ---------------------------------------------------------------------------

describe('getAllMemberUserIdsForEvent', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('returns Set of home-drive members when no shared drives', async () => {
    vi.mocked(getDriveMemberUserIds).mockResolvedValue([USER_ID]);
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValue(stubSelectMany([])); // no junction rows

    const result = await getAllMemberUserIdsForEvent(EVENT_ID, HOME_DRIVE);
    expect(result).toBeInstanceOf(Set);
    expect(result.has(USER_ID)).toBe(true);
  });

  it('returns union Set including shared-drive-only members', async () => {
    vi.mocked(getDriveMemberUserIds).mockResolvedValue([USER_ID]);
    const mockDb = db as unknown as MockDb;
    // junction rows
    mockDb.select
      .mockReturnValueOnce(stubSelectMany([{ driveId: SHARED_DRIVE }]))
      // batched member query
      .mockReturnValue(stubSelectMany([{ userId: USER_ID }, { userId: OTHER_USER }]));

    const result = await getAllMemberUserIdsForEvent(EVENT_ID, HOME_DRIVE);
    expect(result.has(USER_ID)).toBe(true);
    expect(result.has(OTHER_USER)).toBe(true);
  });

  it('deduplicates members who appear in multiple drives', async () => {
    vi.mocked(getDriveMemberUserIds).mockResolvedValue([USER_ID]);
    const mockDb = db as unknown as MockDb;
    mockDb.select
      .mockReturnValueOnce(stubSelectMany([{ driveId: SHARED_DRIVE }]))
      .mockReturnValue(stubSelectMany([{ userId: USER_ID }])); // USER_ID in both

    const result = await getAllMemberUserIdsForEvent(EVENT_ID, HOME_DRIVE);
    expect(result.size).toBe(1);
  });

  it('returns empty Set for personal events', async () => {
    const result = await getAllMemberUserIdsForEvent(EVENT_ID, null as unknown as string);
    expect(result.size).toBe(0);
    expect(getDriveMemberUserIds).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getAllDriveIdsForEvent
// ---------------------------------------------------------------------------

describe('getAllDriveIdsForEvent', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('returns [homeDriveId, ...sharedDriveIds] with home drive first', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select
      .mockReturnValueOnce(stubSelect([BASE_EVENT]))
      .mockReturnValueOnce(stubSelectMany([{ driveId: SHARED_DRIVE }, { driveId: ANOTHER_DRIVE }]));

    const result = await getAllDriveIdsForEvent(EVENT_ID);
    expect(result).toEqual([HOME_DRIVE, SHARED_DRIVE, ANOTHER_DRIVE]);
  });

  it('returns [homeDriveId] when no shared drives', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select
      .mockReturnValueOnce(stubSelect([BASE_EVENT]))
      .mockReturnValueOnce(stubSelectMany([]));

    const result = await getAllDriveIdsForEvent(EVENT_ID);
    expect(result).toEqual([HOME_DRIVE]);
  });

  it('returns [] for personal events (driveId null)', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select.mockReturnValueOnce(stubSelect([{ ...BASE_EVENT, driveId: null }]));

    const result = await getAllDriveIdsForEvent(EVENT_ID);
    expect(result).toEqual([]);
  });

  it('deduplicates if home drive somehow appears in junction table', async () => {
    const mockDb = db as unknown as MockDb;
    mockDb.select
      .mockReturnValueOnce(stubSelect([BASE_EVENT]))
      .mockReturnValueOnce(stubSelectMany([{ driveId: HOME_DRIVE }, { driveId: SHARED_DRIVE }]));

    const result = await getAllDriveIdsForEvent(EVENT_ID);
    expect(result.filter((id) => id === HOME_DRIVE)).toHaveLength(1);
  });
});
