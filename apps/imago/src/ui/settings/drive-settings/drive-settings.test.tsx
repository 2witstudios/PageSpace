// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import useSWR from 'swr';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { blur, click, mount, press, typeInto, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { DRIVES, drivesFrom } from '../../frame/drives/drives';
import { DriveSettingsObject } from './drive-settings';

afterEach(unmountAll);

type DriveFixture = { kind: 'HOME' | 'STANDARD'; isOwned: boolean; role: 'OWNER' | 'ADMIN' | 'MEMBER' };

const OWNER: DriveFixture = { kind: 'STANDARD', isOwned: true, role: 'MEMBER' };

const membersBody = {
  members: [
    {
      userId: 'u1',
      role: 'OWNER',
      user: { id: 'u1', email: 'ada@example.com', name: 'Ada' },
      profile: { username: 'ada', displayName: 'Ada Lovelace', avatarUrl: null },
      customRole: null,
    },
    {
      userId: 'u2',
      role: 'MEMBER',
      user: { id: 'u2', email: 'bo@example.com', name: 'Bo' },
      profile: null,
      customRole: null,
    },
  ],
  pendingInvites: [],
  currentUserRole: 'OWNER',
};

/**
 * apps/web's drive, members and imago-access routes over a little state: a
 * PATCH or PUT the server accepts changes what the next GET answers.
 */
const server = (drive: DriveFixture = OWNER, overrides: Record<string, FakeRoute> = {}) => {
  let name = drive.kind === 'HOME' ? 'Home' : 'Launch';
  let enabled = false;
  return {
    'GET /api/drives/d1': () => Response.json({ id: 'd1', name, ...drive }),
    'GET /api/drives': () => Response.json([{ id: 'd1', name, kind: drive.kind }]),
    'GET /api/drives/d1/members': () => Response.json(membersBody),
    'GET /api/drives/d1/imago-access': () => Response.json({ driveId: 'd1', enabled, agents: [] }),
    'PATCH /api/drives/d1': ({ body }) => {
      name = (body as { name: string }).name;
      return Response.json({ id: 'd1', name });
    },
    'PUT /api/drives/d1/imago-access': ({ body }) => {
      enabled = (body as { enabled: boolean }).enabled;
      return Response.json({ driveId: 'd1', enabled, agents: [] });
    },
    ...overrides,
  } satisfies Record<string, FakeRoute>;
};

/** The shell's drive list (brand chip), on the same SWR key the shell reads. */
function DriveList() {
  const { data } = useSWR<unknown>(DRIVES);
  return <p data-drive-list="">{drivesFrom(data, null)?.map((drive) => drive.name).join(', ')}</p>;
}

/** Puts the caret in a field, as a click would, so leaving it fires blur. */
const focus = (target: HTMLElement): void => {
  act(() => {
    target.focus();
  });
};

/** Waits for `check` to pass, letting React flush between tries. */
const settle = async (check: () => void): Promise<void> => {
  for (let tries = 0; tries < 150; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch {
      // Not yet: flush again.
    }
  }
  check();
};

const open = async (routes: Record<string, FakeRoute>) => {
  const web = fakeWeb(routes);
  const root = mount(
    <ImagoSWRProvider client={web.client}>
      <DriveSettingsObject driveId="d1" />
      <DriveList />
    </ImagoSWRProvider>,
  );
  await settle(() => {
    if (!root.querySelector('[data-drive-list]')?.textContent) throw new Error('no drive list');
    if (!root.querySelector('[aria-label="Members"]')?.textContent?.includes('Bo')) throw new Error('no members');
  });
  return { web, root };
};

const nameInput = (root: ParentNode) => root.querySelector<HTMLInputElement>('input[aria-label="Drive name"]');
const imagoSwitch = (root: ParentNode) => root.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Imago access"]');
const noticeText = (root: ParentNode) => [...root.querySelectorAll('[role="alert"]')].map((node) => node.textContent);

describe('DriveSettingsObject: an owner', () => {
  test('what it shows', async () => {
    const { root, web } = await open(server());
    await settle(() => {
      if (imagoSwitch(root) === null) throw new Error('no switch');
    });
    assert({
      given: "the owner of a standard drive at /imago/d1/settings",
      should: 'show the editable drive name, the members read-only and the Imago access switch from the route',
      actual: {
        name: nameInput(root)?.value,
        members: [...root.querySelectorAll('[aria-label="Members"] li')].map((row) =>
          ['name', 'email', 'role'].map((field) => row.querySelector(`[data-member-${field}]`)?.textContent ?? null),
        ),
        removable: root.querySelectorAll('[aria-label="Members"] button').length,
        switchState: imagoSwitch(root)?.getAttribute('aria-checked'),
        reads: web.requests
          .map((request) => `${request.method} ${request.url}`)
          .filter((key) => key.startsWith('GET /api/drives/d1'))
          .sort(),
      },
      expected: {
        name: 'Launch',
        members: [
          ['Ada Lovelace', 'ada@example.com', 'Owner'],
          ['Bo', 'bo@example.com', 'Member'],
        ],
        removable: 0,
        switchState: 'false',
        reads: ['GET /api/drives/d1', 'GET /api/drives/d1/imago-access', 'GET /api/drives/d1/members'],
      },
    });
  });

  test('renaming the drive', async () => {
    const { root, web } = await open(server());
    const input = nameInput(root) as HTMLInputElement;
    focus(input);
    typeInto(input, '  Launch 2026 ');
    press(input, 'Enter');
    await settle(() => {
      if (root.querySelector('[data-drive-list]')?.textContent !== 'Launch 2026') throw new Error('drive list stale');
    });
    assert({
      given: 'a new name committed with Enter',
      should: "PATCH the drive route with the trimmed name and web's CSRF token, then refresh the shell's drive list",
      actual: {
        writes: web.writes().map(({ method, url, body, csrf }) => ({ method, url, body, csrf })),
        name: nameInput(root)?.value,
        driveList: root.querySelector('[data-drive-list]')?.textContent,
        notices: noticeText(root),
      },
      expected: {
        writes: [{ method: 'PATCH', url: '/api/drives/d1', body: { name: 'Launch 2026' }, csrf: 'tok-1' }],
        name: 'Launch 2026',
        driveList: 'Launch 2026',
        notices: [],
      },
    });
  });

  test('an unchanged or blank name', async () => {
    const { root, web } = await open(server());
    const input = nameInput(root) as HTMLInputElement;
    focus(input);
    typeInto(input, '   ');
    blur(input);
    focus(input);
    typeInto(input, 'Launch');
    blur(input);
    assert({
      given: 'a blank name, then the same name, left',
      should: 'send nothing and keep the name',
      actual: { writes: web.writes().length, name: input.value },
      expected: { writes: 0, name: 'Launch' },
    });
  });

  test('a rename the server refuses', async () => {
    const { root, web } = await open(
      server(OWNER, {
        'PATCH /api/drives/d1': () => Response.json({ error: 'Cannot rename a drive to that name.' }, { status: 400 }),
      }),
    );
    const input = nameInput(root) as HTMLInputElement;
    focus(input);
    typeInto(input, 'Home');
    blur(input);
    await settle(() => {
      if (noticeText(root).length === 0) throw new Error('no notice');
    });
    assert({
      given: 'a reserved name the drive route answers 400 for',
      should: "roll the name back and say why",
      actual: { writes: web.writes().length, name: nameInput(root)?.value, notices: noticeText(root) },
      expected: { writes: 1, name: 'Launch', notices: ['Cannot rename a drive to that name.'] },
    });
  });

  test('turning Imago access on', async () => {
    const { root, web } = await open(server());
    await settle(() => {
      if (imagoSwitch(root) === null) throw new Error('no switch');
    });
    click(imagoSwitch(root) as HTMLButtonElement);
    await settle(() => {
      if (imagoSwitch(root)?.disabled !== false || web.writes().length === 0) throw new Error('pending');
    });
    assert({
      given: 'a click on the switch',
      should: "PUT { enabled: true } to the imago-access route with web's CSRF token and show it on",
      actual: {
        writes: web.writes().map(({ method, url, body, csrf }) => ({ method, url, body, csrf })),
        state: imagoSwitch(root)?.getAttribute('aria-checked'),
      },
      expected: {
        writes: [{ method: 'PUT', url: '/api/drives/d1/imago-access', body: { enabled: true }, csrf: 'tok-1' }],
        state: 'true',
      },
    });
  });

  test('a toggle the server refuses', async () => {
    let answer: (response: Response) => void = () => {};
    const { root } = await open(
      server(OWNER, {
        'PUT /api/drives/d1/imago-access': () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      }),
    );
    await settle(() => {
      if (imagoSwitch(root) === null) throw new Error('no switch');
    });
    click(imagoSwitch(root) as HTMLButtonElement);
    await settle(() => {
      if (imagoSwitch(root)?.getAttribute('aria-checked') !== 'true') throw new Error('not optimistic');
    });
    const during = { state: imagoSwitch(root)?.getAttribute('aria-checked'), disabled: imagoSwitch(root)?.disabled };
    await act(async () => {
      answer(Response.json({ error: 'Your Imago agents are not set up yet' }, { status: 409 }));
    });
    await settle(() => {
      if (noticeText(root).length === 0) throw new Error('no notice');
    });
    assert({
      given: 'a click the route answers 409 for',
      should: 'show it on while it is sent, then roll back to off and say why',
      actual: {
        during,
        after: imagoSwitch(root)?.getAttribute('aria-checked'),
        disabled: imagoSwitch(root)?.disabled,
        notices: noticeText(root),
      },
      expected: {
        during: { state: 'true', disabled: true },
        after: 'false',
        disabled: false,
        notices: ['Your Imago agents are not set up yet'],
      },
    });
  });
});

describe('DriveSettingsObject: an admin who lost the right', () => {
  test('403 from the toggle', async () => {
    const { root } = await open(
      server({ kind: 'STANDARD', isOwned: false, role: 'ADMIN' }, {
        'PUT /api/drives/d1/imago-access': () =>
          Response.json({ error: 'Only drive owners and admins can manage Imago access' }, { status: 403 }),
      }),
    );
    await settle(() => {
      if (imagoSwitch(root) === null) throw new Error('no switch');
    });
    click(imagoSwitch(root) as HTMLButtonElement);
    await settle(() => {
      if (noticeText(root).length === 0) throw new Error('no notice');
    });
    assert({
      given: 'an admin whose role was revoked since the page loaded',
      should: 'roll the switch back and say the server refused',
      actual: { state: imagoSwitch(root)?.getAttribute('aria-checked'), notices: noticeText(root) },
      expected: { state: 'false', notices: ['Only drive owners and admins can manage Imago access'] },
    });
  });
});

describe('DriveSettingsObject: a member', () => {
  test('no actions', async () => {
    const { root, web } = await open(server({ kind: 'STANDARD', isOwned: false, role: 'MEMBER' }));
    assert({
      given: 'a viewer who is only a member of the drive',
      should: 'show the name as text, no switch, and never ask the admin-only imago-access route',
      actual: {
        input: nameInput(root),
        name: root.querySelector('[data-drive-name]')?.textContent,
        switch: imagoSwitch(root),
        asked: web.count('GET /api/drives/d1/imago-access'),
      },
      expected: { input: null, name: 'Launch', switch: null, asked: 0 },
    });
  });
});

describe('DriveSettingsObject: the Home drive', () => {
  test('hides what the guards forbid', async () => {
    const { root, web } = await open(server({ kind: 'HOME', isOwned: true, role: 'MEMBER' }));
    assert({
      given: "the viewer's own Home drive, which they own",
      should: 'offer neither rename nor the toggle, and say why with the guards\' words',
      actual: {
        input: nameInput(root),
        switch: imagoSwitch(root),
        asked: web.count('GET /api/drives/d1/imago-access'),
        says: root.textContent?.includes(
          'Your Imago agents live in your Home drive, so their access to it cannot be changed.',
        ),
      },
      expected: { input: null, switch: null, asked: 0, says: true },
    });
  });
});

describe('DriveSettingsObject: edges', () => {
  test('a failed load', async () => {
    let fail = true;
    const web = fakeWeb(
      server(OWNER, {
        'GET /api/drives/d1': () =>
          fail
            ? Response.json({ error: 'Failed to fetch drive' }, { status: 500 })
            : Response.json({ id: 'd1', name: 'Launch', ...OWNER }),
      }),
    );
    const root = mount(
      <ImagoSWRProvider client={web.client}>
        <DriveSettingsObject driveId="d1" />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (root.querySelector('[data-error]') === null) throw new Error('no error');
    });
    fail = false;
    click([...root.querySelectorAll('button')].find((button) => button.textContent === 'Try again') as HTMLButtonElement);
    await settle(() => {
      if (nameInput(root) === null) throw new Error('not reloaded');
    });
    assert({
      given: 'the drive route failing, then a retry that succeeds',
      should: 'draw the retryable error, then the settings',
      actual: nameInput(root)?.value,
      expected: 'Launch',
    });
  });
});
