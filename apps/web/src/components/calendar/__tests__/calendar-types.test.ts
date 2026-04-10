import { describe, test } from 'vitest';
import { assert } from './riteway';
import {
  DRIVE_CALENDAR_COLORS,
  PERSONAL_CALENDAR_COLOR,
  getDriveCalendarColor,
  resolveEventColor,
  getEventColors,
} from '../calendar-types';
import type { CalendarEvent, EventColorConfig } from '../calendar-types';

describe('DRIVE_CALENDAR_COLORS', () => {
  test('palette structure', () => {
    assert({
      given: 'the drive calendar palette',
      should: 'have at least 8 distinct colors',
      actual: DRIVE_CALENDAR_COLORS.length >= 8,
      expected: true,
    });

    const first = DRIVE_CALENDAR_COLORS[0];
    assert({
      given: 'a palette entry',
      should: 'have bg, border, text, and dot properties',
      actual: 'bg' in first && 'border' in first && 'text' in first && 'dot' in first,
      expected: true,
    });
  });
});

describe('PERSONAL_CALENDAR_COLOR', () => {
  test('structure', () => {
    assert({
      given: 'the personal calendar color',
      should: 'have bg, border, text, and dot properties',
      actual:
        'bg' in PERSONAL_CALENDAR_COLOR &&
        'border' in PERSONAL_CALENDAR_COLOR &&
        'text' in PERSONAL_CALENDAR_COLOR &&
        'dot' in PERSONAL_CALENDAR_COLOR,
      expected: true,
    });
  });
});

describe('getDriveCalendarColor', () => {
  const driveIds = ['drive-aaa', 'drive-bbb', 'drive-ccc'];

  test('personal events', () => {
    const color = getDriveCalendarColor(null, driveIds);
    assert({
      given: 'a personal event (driveId=null)',
      should: 'return the personal calendar color',
      actual: color,
      expected: PERSONAL_CALENDAR_COLOR,
    });
  });

  test('deterministic assignment', () => {
    const color1 = getDriveCalendarColor('drive-aaa', driveIds);
    const color2 = getDriveCalendarColor('drive-aaa', driveIds);
    assert({
      given: 'the same driveId called twice',
      should: 'return the same color both times',
      actual: color1,
      expected: color2,
    });
  });

  test('different drives get different colors', () => {
    const colorA = getDriveCalendarColor('drive-aaa', driveIds);
    const colorB = getDriveCalendarColor('drive-bbb', driveIds);
    assert({
      given: 'two different driveIds',
      should: 'return different colors',
      actual: colorA.dot !== colorB.dot,
      expected: true,
    });
  });

  test('stable across drive order', () => {
    const shuffled = ['drive-ccc', 'drive-aaa', 'drive-bbb'];
    const colorOriginal = getDriveCalendarColor('drive-bbb', driveIds);
    const colorShuffled = getDriveCalendarColor('drive-bbb', shuffled);
    assert({
      given: 'the same driveId with different array orderings',
      should: 'return the same color (sorts internally)',
      actual: colorOriginal,
      expected: colorShuffled,
    });
  });

  test('unknown driveId fallback', () => {
    const color = getDriveCalendarColor('drive-unknown', driveIds);
    assert({
      given: 'a driveId not in the driveIds array',
      should: 'return the first palette color as fallback',
      actual: color,
      expected: DRIVE_CALENDAR_COLORS[0],
    });
  });
});

describe('resolveEventColor', () => {
  const driveColorMap = new Map<string | null, EventColorConfig>([
    [null, PERSONAL_CALENDAR_COLOR],
    ['drive-aaa', DRIVE_CALENDAR_COLORS[0]],
    ['drive-bbb', DRIVE_CALENDAR_COLORS[1]],
  ]);

  const makeEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id: 'evt-1',
    driveId: 'drive-aaa',
    createdById: 'user-1',
    pageId: null,
    title: 'Test Event',
    description: null,
    location: null,
    startAt: '2026-04-10T09:00:00Z',
    endAt: '2026-04-10T10:00:00Z',
    allDay: false,
    timezone: 'UTC',
    recurrenceRule: null,
    visibility: 'DRIVE',
    color: 'meeting',
    syncedFromGoogle: false,
    googleSyncReadOnly: null,
    createdAt: '2026-04-10T08:00:00Z',
    updatedAt: '2026-04-10T08:00:00Z',
    createdBy: { id: 'user-1', name: 'Test', image: null },
    attendees: [],
    ...overrides,
  });

  test('user context with drive color map', () => {
    const event = makeEvent({ driveId: 'drive-aaa', color: 'meeting' });
    const color = resolveEventColor(event, 'user', driveColorMap);
    assert({
      given: 'a drive event in user context with a driveColorMap',
      should: 'return the drive color, not the event color',
      actual: color,
      expected: DRIVE_CALENDAR_COLORS[0],
    });
  });

  test('user context personal event', () => {
    const event = makeEvent({ driveId: null, color: 'default' });
    const color = resolveEventColor(event, 'user', driveColorMap);
    assert({
      given: 'a personal event in user context',
      should: 'return the personal calendar color',
      actual: color,
      expected: PERSONAL_CALENDAR_COLOR,
    });
  });

  test('drive context ignores drive color map', () => {
    const event = makeEvent({ driveId: 'drive-aaa', color: 'meeting' });
    const color = resolveEventColor(event, 'drive', driveColorMap);
    assert({
      given: 'an event in drive context',
      should: 'return the per-event color, not the drive color',
      actual: color,
      expected: getEventColors('meeting'),
    });
  });

  test('null driveColorMap falls back to event color', () => {
    const event = makeEvent({ color: 'deadline' });
    const color = resolveEventColor(event, 'user', null);
    assert({
      given: 'a null driveColorMap',
      should: 'fall back to the per-event color',
      actual: color,
      expected: getEventColors('deadline'),
    });
  });
});
