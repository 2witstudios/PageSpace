/**
 * Room grammar (#2158): the ONE definition of every Socket.IO room-name shape.
 *
 * These tests pin two invariants:
 * 1. Builders produce exactly the documented shapes (so join sites, kick
 *    payloads, and broadcast channelIds all agree on the grammar).
 * 2. Every builder's output is accepted by `isKnownRoomId`, and everything
 *    else is rejected — the validator and the builders cannot drift because
 *    they live in one module and this suite crosses them.
 */
import { describe, expect, it } from 'vitest';
import {
  isCUID2,
  pageRoom,
  notificationsRoom,
  userTasksRoom,
  userCalendarRoom,
  userDrivesRoom,
  userGlobalRoom,
  userSessionsRoom,
  driveRoom,
  driveCalendarRoom,
  dmRoom,
  sessionRoom,
  conversationRoom,
  driveActivityRoom,
  pageActivityRoom,
  isKnownRoomId,
  roomsForDriveKick,
  roomsForPageKick,
  roomsForConversationKick,
  roomsForWorkspaceKick,
  ALL_ROOM_BUILDERS,
} from '../rooms';

const id = 'tz4a98xxat96iws9zmbrgj3a'; // CUID2-shaped

describe('room builders', () => {
  it('build the documented shapes', () => {
    expect(pageRoom(id)).toBe(id);
    expect(notificationsRoom(id)).toBe(`notifications:${id}`);
    expect(userTasksRoom(id)).toBe(`user:${id}:tasks`);
    expect(userCalendarRoom(id)).toBe(`user:${id}:calendar`);
    expect(userDrivesRoom(id)).toBe(`user:${id}:drives`);
    expect(userGlobalRoom(id)).toBe(`user:${id}:global`);
    expect(userSessionsRoom(id)).toBe(`user:${id}:sessions`);
    expect(driveRoom(id)).toBe(`drive:${id}`);
    expect(driveCalendarRoom(id)).toBe(`drive:${id}:calendar`);
    expect(dmRoom(id)).toBe(`dm:${id}`);
    expect(sessionRoom(id)).toBe(`session:${id}`);
    expect(conversationRoom(id)).toBe(`conv:${id}`);
    expect(driveActivityRoom(id)).toBe(`activity:drive:${id}`);
    expect(pageActivityRoom(id)).toBe(`activity:page:${id}`);
  });

  it('ALL_ROOM_BUILDERS covers every exported builder', () => {
    expect(ALL_ROOM_BUILDERS).toHaveLength(14);
    const outputs = ALL_ROOM_BUILDERS.map((build) => build(id));
    expect(new Set(outputs).size).toBe(14);
  });
});

describe('isKnownRoomId', () => {
  it('accepts every builder output (grammar cannot drift from the joins)', () => {
    for (const build of ALL_ROOM_BUILDERS) {
      expect(isKnownRoomId(build(id)), `expected ${build(id)} to be a known room`).toBe(true);
    }
  });

  it('rejects non-CUID2 identifiers embedded in otherwise-valid shapes', () => {
    expect(isKnownRoomId('not a cuid')).toBe(false);
    expect(isKnownRoomId('notifications:NOT-A-CUID')).toBe(false);
    expect(isKnownRoomId('dm:UPPER')).toBe(false);
    expect(isKnownRoomId('session:NOT-A-CUID')).toBe(false);
    expect(isKnownRoomId(`drive:${'x'.repeat(40)}`)).toBe(false);
    expect(isKnownRoomId('drive:9startswithdigit')).toBe(false);
    expect(isKnownRoomId(`user:BAD:tasks`)).toBe(false);
    expect(isKnownRoomId(`activity:drive:BAD`)).toBe(false);
  });

  it('rejects unknown prefixes, suffixes, and scopes', () => {
    expect(isKnownRoomId(`bogus:${id}`)).toBe(false);
    expect(isKnownRoomId(`user:${id}:bogus`)).toBe(false);
    expect(isKnownRoomId(`drive:${id}:bogus`)).toBe(false);
    expect(isKnownRoomId(`activity:bogus:${id}`)).toBe(false);
    expect(isKnownRoomId(`notifications:${id}:extra`)).toBe(false);
    expect(isKnownRoomId(`user:${id}:tasks:extra`)).toBe(false);
  });

  it('rejects wildcards, empties, and prefix-shaped strings', () => {
    expect(isKnownRoomId('')).toBe(false);
    expect(isKnownRoomId('*')).toBe(false);
    expect(isKnownRoomId('drive:*')).toBe(false);
    expect(isKnownRoomId('conv:*')).toBe(false);
    expect(isKnownRoomId('drive:')).toBe(false);
    expect(isKnownRoomId(':')).toBe(false);
  });
});

describe('isCUID2', () => {
  it('accepts CUID2-shaped strings and rejects everything else', () => {
    expect(isCUID2(id)).toBe(true);
    expect(isCUID2('ab')).toBe(true);
    expect(isCUID2('a')).toBe(false);
    expect(isCUID2('x'.repeat(33))).toBe(false);
    expect(isCUID2('1startsdigit')).toBe(false);
    expect(isCUID2('UPPERCASE')).toBe(false);
    expect(isCUID2(42)).toBe(false);
    expect(isCUID2(undefined)).toBe(false);
  });
});

describe('kick room sets', () => {
  it('drive kick covers drive, drive calendar, and drive activity rooms', () => {
    expect(roomsForDriveKick(id)).toEqual([
      `drive:${id}`,
      `drive:${id}:calendar`,
      `activity:drive:${id}`,
    ]);
  });

  it('page kick covers the page room and the page activity room', () => {
    expect(roomsForPageKick(id)).toEqual([id, `activity:page:${id}`]);
  });

  it('conversation kick covers the conv content room', () => {
    expect(roomsForConversationKick(id)).toEqual([`conv:${id}`]);
  });

  it('workspace kick covers the session layout room', () => {
    expect(roomsForWorkspaceKick(id)).toEqual([`session:${id}`]);
  });

  /**
   * THE GUARD THAT WAS MISSING (security review HIGH 3).
   *
   * These four sets used to be asserted one at a time, which pinned the
   * `conv:` and `session:` rooms' ABSENCE as correct: the epic moved chat
   * content off the page room onto `conv:<id>` and layout onto
   * `session:<id>`, neither of which any revocation path kicked, and the
   * suite stayed green because nothing ever asked "is every room shape
   * accounted for?".
   *
   * So ask it. Every builder in the grammar is either revocation-scoped —
   * some kick set must produce it — or explicitly PERSONAL: a room whose only
   * member is the user it is named after, which no third party's revocation
   * can ever need to evict them from. A new room shape is a compile-and-test
   * failure here until it is classified.
   */
  it('every room shape in the grammar is either revocation-scoped or explicitly personal', () => {
    const kickable = new Set([
      ...roomsForDriveKick(id),
      ...roomsForPageKick(id),
      ...roomsForConversationKick(id),
      ...roomsForWorkspaceKick(id),
    ]);
    /** Rooms named after the user themself — revoking someone else's grant never touches them. */
    const personal = new Set([
      notificationsRoom(id),
      userTasksRoom(id),
      userCalendarRoom(id),
      userDrivesRoom(id),
      userGlobalRoom(id),
      userSessionsRoom(id),
      // A DM room's membership is the participant list; leaving a drive does
      // not end a direct message between two people.
      dmRoom(id),
    ]);

    const unclassified = ALL_ROOM_BUILDERS.map((build) => build(id)).filter(
      (room) => !kickable.has(room) && !personal.has(room),
    );
    expect(unclassified, 'every room shape must be kickable on revocation or personal').toEqual([]);
  });
});
