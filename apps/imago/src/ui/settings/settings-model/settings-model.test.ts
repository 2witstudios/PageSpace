import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  accountLinks,
  driveActions,
  driveEndpoint,
  driveOf,
  imagoAccessEndpoint,
  imagoAccessOf,
  membersEndpoint,
  membersFrom,
} from './settings-model';

describe('settings endpoints', () => {
  test('apps/web routes for one drive', () => {
    assert({
      given: 'a drive id with a character that is not a path segment',
      should: 'escape it into one segment of each apps/web route',
      actual: [driveEndpoint('d/1'), membersEndpoint('d/1'), imagoAccessEndpoint('d/1')],
      expected: ['/api/drives/d%2F1', '/api/drives/d%2F1/members', '/api/drives/d%2F1/imago-access'],
    });
  });
});

describe('driveOf', () => {
  test('an owned drive', () => {
    assert({
      given: "GET /api/drives/[driveId]'s body for a drive the viewer owns",
      should: 'name it, keep its kind and make the viewer its OWNER',
      actual: driveOf({ id: 'd1', name: 'Launch', kind: 'STANDARD', isOwned: true, role: 'MEMBER' }),
      expected: { id: 'd1', name: 'Launch', kind: 'STANDARD', role: 'OWNER' },
    });
  });

  test('a drive the viewer is a member of', () => {
    assert({
      given: 'a drive the viewer holds ADMIN in',
      should: 'carry the role the API gave',
      actual: driveOf({ id: 'd1', name: 'Launch', kind: 'STANDARD', isOwned: false, role: 'ADMIN' })?.role,
      expected: 'ADMIN',
    });
  });

  test('a drive with no kind', () => {
    assert({
      given: 'a drive without a kind (a stale shape)',
      should: 'treat it as STANDARD, never as Home',
      actual: driveOf({ id: 'd1', name: 'Launch', isOwned: false, role: 'MEMBER' })?.kind,
      expected: 'STANDARD',
    });
  });

  test('an unknown role', () => {
    assert({
      given: 'a role the settings do not know (a guest)',
      should: 'grant nothing more than MEMBER',
      actual: driveOf({ id: 'd1', name: 'Launch', kind: 'STANDARD', isOwned: false, role: 'GUEST' })?.role,
      expected: 'MEMBER',
    });
  });

  test('not a drive', () => {
    assert({
      given: 'an error body or nothing',
      should: 'be no drive',
      actual: [driveOf({ error: 'Access denied' }), driveOf(null), driveOf({ id: 'd1' })],
      expected: [null, null, null],
    });
  });
});

describe('driveActions', () => {
  const standard = { id: 'd1', name: 'Launch', kind: 'STANDARD', role: 'OWNER' } as const;

  test('owner and admin of a standard drive', () => {
    assert({
      given: 'a standard drive the viewer owns or administers',
      should: 'offer rename and the Imago access toggle',
      actual: [driveActions(standard), driveActions({ ...standard, role: 'ADMIN' })],
      expected: [
        { rename: true, imagoAccess: true },
        { rename: true, imagoAccess: true },
      ],
    });
  });

  test('a member', () => {
    assert({
      given: 'a standard drive the viewer is only a member of',
      should: 'offer no action: the drive routes refuse non-admins',
      actual: driveActions({ ...standard, role: 'MEMBER' }),
      expected: { rename: false, imagoAccess: false },
    });
  });

  test('the Home drive', () => {
    assert({
      given: "the viewer's own Home drive",
      should: 'offer neither rename nor the toggle, as the Home drive guards refuse both',
      actual: driveActions({ ...standard, kind: 'HOME' }),
      expected: { rename: false, imagoAccess: false },
    });
  });
});

describe('membersFrom', () => {
  test('the members route body', () => {
    assert({
      given: 'GET /api/drives/[driveId]/members with an owner and an admin',
      should: 'list them in order, named by display name, then name, then email',
      actual: membersFrom({
        members: [
          {
            userId: 'u1',
            role: 'OWNER',
            user: { id: 'u1', email: 'ada@example.com', name: 'Ada L' },
            profile: { username: 'ada', displayName: 'Ada Lovelace', avatarUrl: null },
            customRole: null,
          },
          {
            userId: 'u2',
            role: 'ADMIN',
            user: { id: 'u2', email: 'bo@example.com', name: null },
            profile: null,
            customRole: { id: 'r1', name: 'Editors', color: null },
          },
        ],
        pendingInvites: [],
        currentUserRole: 'OWNER',
      }),
      expected: [
        { userId: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', role: 'OWNER', customRole: null },
        { userId: 'u2', name: 'bo@example.com', email: 'bo@example.com', role: 'ADMIN', customRole: 'Editors' },
      ],
    });
  });

  test('malformed rows and bodies', () => {
    assert({
      given: 'a row with no user id, and a body that is not a members answer',
      should: 'drop the row, and be no list for the body',
      actual: [membersFrom({ members: [{ role: 'MEMBER' }] }), membersFrom({ error: 'nope' })],
      expected: [[], null],
    });
  });
});

describe('imagoAccessOf', () => {
  test('the imago-access route body', () => {
    assert({
      given: 'GET /api/drives/[driveId]/imago-access',
      should: 'read only whether access is on',
      actual: [
        imagoAccessOf({ driveId: 'd1', enabled: true, agents: [] }),
        imagoAccessOf({ driveId: 'd1', enabled: false, agents: [] }),
        imagoAccessOf({ error: 'Only drive owners and admins can manage Imago access' }),
      ],
      expected: [{ enabled: true }, { enabled: false }, null],
    });
  });
});

describe('accountLinks', () => {
  test('with billing', () => {
    assert({
      given: 'a deployment that bills in the app',
      should: "link account, billing and connections to classic's settings pages",
      actual: accountLinks({ billing: true }).map(({ label, href }) => [label, href]),
      expected: [
        ['Account', '/settings/account'],
        ['Billing', '/settings/billing'],
        ['Connections', '/settings/integrations'],
      ],
    });
  });

  test('without billing', () => {
    assert({
      given: 'a tenant or on-prem deployment, where classic hides billing',
      should: 'leave billing out',
      actual: accountLinks({ billing: false }).map(({ label }) => label),
      expected: ['Account', 'Connections'],
    });
  });
});
