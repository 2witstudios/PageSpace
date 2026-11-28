import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ageLabel, drivePageHref, recentsOf, RECENTS } from './recents';

const now = new Date('2026-10-12T10:20:00.000Z');
const body = {
  recents: [
    { id: 'plan', title: 'Q4 Launch Plan', type: 'DOCUMENT', driveId: 'studio', driveName: 'Studio', viewedAt: '2026-10-12T10:20:00.000Z' },
    { id: 'other', title: 'Elsewhere', type: 'DOCUMENT', driveId: 'home', driveName: 'Home', viewedAt: '2026-10-12T10:00:00.000Z' },
    { id: 'pricing', title: 'Pricing Model', type: 'SHEET', driveId: 'studio', driveName: 'Studio', viewedAt: '2026-10-12T09:20:00.000Z' },
    { id: 'ops', title: 'launch-ops', type: 'CHANNEL', driveId: 'studio', driveName: 'Studio', viewedAt: '2026-10-12T08:20:00.000Z' },
    { id: 'bad', title: 7, type: 'DOCUMENT', driveId: 'studio', viewedAt: 'x' },
  ],
};

describe('recentsOf() (IMC-1.7)', () => {
  test("the drive's recents", () => {
    assert({
      given: "apps/web's recents across drives",
      should: "keep this drive's, newest first, at most three",
      actual: recentsOf(body, 'studio', 3).map((row) => row.id),
      expected: ['plan', 'pricing', 'ops'],
    });
  });

  test("every drive's recents", () => {
    assert({
      given: "apps/web's recents with no drive to keep",
      should: 'keep every drive’s, each with its drive, newest first',
      actual: recentsOf(body, null, 3).map((row) => [row.id, row.driveId]),
      expected: [['plan', 'studio'], ['other', 'home'], ['pricing', 'studio']],
    });
  });

  test('not a recents body', () => {
    assert({
      given: 'nothing loaded or an error body',
      should: 'list nothing',
      actual: [recentsOf(undefined, 'studio', 3), recentsOf({ error: 'x' }, 'studio', 3)],
      expected: [[], []],
    });
  });

  test('the route', () => {
    assert({
      given: 'the recents rows',
      should: 'ask for enough rows to fill three from one drive',
      actual: RECENTS,
      expected: '/api/user/recents?limit=20',
    });
  });
});

describe('ageLabel()', () => {
  test('the boards’ short ages', () => {
    assert({
      given: 'views just now, minutes, hours, yesterday and last week',
      should: 'read now, 5m, 1h, 2h, Yesterday and the date',
      actual: [
        '2026-10-12T10:19:40.000Z',
        '2026-10-12T10:15:00.000Z',
        '2026-10-12T09:20:00.000Z',
        '2026-10-12T08:20:00.000Z',
        '2026-10-11T12:00:00.000Z',
        '2026-10-05T12:00:00.000Z',
      ].map((iso) => ageLabel(iso, now)),
      expected: ['now', '5m', '1h', '2h', 'Yesterday', 'Oct 5'],
    });
  });
});

describe('drivePageHref()', () => {
  test('a page in its drive', () => {
    assert({
      given: 'a recent page',
      should: 'open it under Files in its drive',
      actual: drivePageHref('studio', 'plan'),
      expected: '/studio/files/plan',
    });
  });
});
