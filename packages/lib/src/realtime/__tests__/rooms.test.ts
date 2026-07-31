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
  driveRoom,
  driveCalendarRoom,
  dmRoom,
  driveActivityRoom,
  pageActivityRoom,
  isKnownRoomId,
  roomsForDriveKick,
  roomsForPageKick,
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
    expect(driveRoom(id)).toBe(`drive:${id}`);
    expect(driveCalendarRoom(id)).toBe(`drive:${id}:calendar`);
    expect(dmRoom(id)).toBe(`dm:${id}`);
    expect(driveActivityRoom(id)).toBe(`activity:drive:${id}`);
    expect(pageActivityRoom(id)).toBe(`activity:page:${id}`);
  });

  it('ALL_ROOM_BUILDERS covers every exported builder', () => {
    expect(ALL_ROOM_BUILDERS).toHaveLength(11);
    const outputs = ALL_ROOM_BUILDERS.map((build) => build(id));
    expect(new Set(outputs).size).toBe(11);
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
});
