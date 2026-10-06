import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { stageFor } from '../stage/stage';
import { driveStatus, drivesFrom, switchDriveHref, type DriveSummary } from './drives';

/** A drive as apps/web's GET /api/drives returns it (DriveWithAccess, JSON). */
const apiDrive = (id: string, name: string, kind: 'HOME' | 'STANDARD' = 'STANDARD') => ({
  id,
  name,
  slug: name.toLowerCase(),
  ownerId: 'user-1',
  kind,
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  isOwned: true,
  role: 'OWNER',
  canCreatePages: true,
  lastAccessedAt: null,
  homePageId: null,
});

describe('drivesFrom()', () => {
  test('the viewer’s drives, Home first', () => {
    const body = [apiDrive('d-zeta', 'zeta'), apiDrive('d-alpha', 'Alpha'), apiDrive('home-1', 'Home', 'HOME'), apiDrive('d-beta', 'beta')];

    assert({
      given: '/api/drives listing Home among three other drives',
      should: 'keep only id, name and kind, with the Home drive first and the rest by name, ignoring case',
      actual: drivesFrom(body, 'home-1'),
      expected: [
        { id: 'home-1', name: 'Home', kind: 'HOME' },
        { id: 'd-alpha', name: 'Alpha', kind: 'STANDARD' },
        { id: 'd-beta', name: 'beta', kind: 'STANDARD' },
        { id: 'd-zeta', name: 'zeta', kind: 'STANDARD' },
      ],
    });
  });

  test('another user’s Home drive', () => {
    const body = [apiDrive('home-2', 'Home', 'HOME'), apiDrive('d-alpha', 'Alpha'), apiDrive('home-1', 'Home', 'HOME')];

    assert({
      given: 'a page shared from someone else’s Home drive beside the viewer’s own',
      should: 'put only the viewer’s Home first and sort the other Home with the rest',
      actual: drivesFrom(body, 'home-1')?.map((drive) => drive.id),
      expected: ['home-1', 'd-alpha', 'home-2'],
    });
  });

  test('no Home drive yet', () => {
    assert({
      given: 'a viewer the Home backfill has not reached',
      should: 'list the drives by name',
      actual: drivesFrom([apiDrive('d-beta', 'Beta'), apiDrive('d-alpha', 'Alpha')], null)?.map((drive) => drive.id),
      expected: ['d-alpha', 'd-beta'],
    });
  });

  test('what the API did not say', () => {
    const body = [
      apiDrive('d-alpha', 'Alpha'),
      { ...apiDrive('d-trashed', 'Old'), isTrashed: true },
      { id: 'd-noname' },
      { name: 'No id' },
      { ...apiDrive('d-odd', 'Odd'), kind: 'SOMETHING' },
      null,
      'd-string',
    ];

    assert({
      given: 'trashed and malformed entries beside a drive',
      should: 'drop each instead of inventing a name or kind for it',
      actual: drivesFrom(body, null),
      expected: [{ id: 'd-alpha', name: 'Alpha', kind: 'STANDARD' }],
    });

    assert({
      given: 'a body that is not a list (nothing loaded yet, or an error body)',
      should: 'claim no list at all',
      actual: [drivesFrom(undefined, null), drivesFrom({ error: 'Failed' }, null)],
      expected: [null, null],
    });
  });

  test('the server’s own list', () => {
    const summaries: DriveSummary[] = [{ id: 'd-alpha', name: 'Alpha', kind: 'STANDARD' }];

    assert({
      given: 'the summaries the shell layout rendered with',
      should: 'read them as it reads the API',
      actual: drivesFrom(summaries, null),
      expected: summaries,
    });
  });
});

describe('switchDriveHref()', () => {
  const cases: Array<[string, string]> = [
    ['/drive-1', '/drive-2'],
    ['/drive-1/files', '/drive-2/files'],
    ['/drive-1/files/page-1', '/drive-2/files'],
    ['/drive-1/messages', '/drive-2/messages'],
    ['/drive-1/messages/channel-1', '/drive-2/messages'],
    ['/drive-1/tasks/list-1', '/drive-2/tasks'],
    ['/drive-1/settings', '/drive-2/settings'],
    ['/dm', '/drive-2/messages'],
    ['/dm/conversation-1', '/drive-2/messages'],
    ['/account', '/drive-2'],
  ];

  for (const [from, to] of cases) {
    test(`from ${from}`, () => {
      assert({
        given: `${from}, and drive-2 picked`,
        should: `keep the section in drive-2 (${to}); an object belongs to the drive it was opened in`,
        actual: switchDriveHref(stageFor(from), 'drive-2'),
        expected: to,
      });
    });
  }

  test('an id that is not one', () => {
    assert({
      given: 'a drive id carrying path syntax',
      should: 'escape it into one segment',
      actual: switchDriveHref(stageFor('/drive-1/files'), '../x'),
      expected: '/..%2Fx/files',
    });
  });
});

describe('driveStatus()', () => {
  const drives: DriveSummary[] = [{ id: 'd-alpha', name: 'Alpha', kind: 'STANDARD' }];

  test('each answer', () => {
    assert({
      given: 'a listed drive, an unlisted one, a stage with no drive and no list yet',
      should: 'answer listed, missing, none and unknown',
      actual: [
        driveStatus(drives, 'd-alpha'),
        driveStatus(drives, 'd-other'),
        driveStatus(drives, null),
        driveStatus(null, 'd-alpha'),
      ],
      expected: ['listed', 'missing', 'none', 'unknown'],
    });
  });
});
