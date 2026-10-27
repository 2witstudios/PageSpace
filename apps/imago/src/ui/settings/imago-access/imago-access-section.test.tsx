// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { click, mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { ImagoAccessSection } from './imago-access-section';

afterEach(unmountAll);

const drive = (kind: 'HOME' | 'STANDARD') => ({ id: 'd1', name: 'Launch', kind, isOwned: true, role: 'MEMBER' });

const server = (kind: 'HOME' | 'STANDARD' = 'STANDARD', overrides: Record<string, FakeRoute> = {}) => {
  let enabled = true;
  return {
    'GET /api/drives/d1': () => Response.json(drive(kind)),
    'GET /api/drives/d1/imago-access': () => Response.json({ driveId: 'd1', enabled }),
    'PUT /api/drives/d1/imago-access': ({ body }) => {
      enabled = (body as { enabled: boolean }).enabled;
      return Response.json({ driveId: 'd1', enabled });
    },
    ...overrides,
  } satisfies Record<string, FakeRoute>;
};

const settle = async (check: () => void): Promise<void> => {
  for (let tries = 0; tries < 150; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch {
      // Not yet.
    }
  }
  check();
};

const switchOf = (root: ParentNode) => root.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Imago access"]');

describe('ImagoAccessSection', () => {
  test('a standard drive: the switch shows the route answer and a click writes the other value', async () => {
    const web = fakeWeb(server());
    const root = mount(
      <ImagoSWRProvider client={web.client}>
        <ImagoAccessSection driveId="d1" />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (switchOf(root) === null) throw new Error('no switch yet');
    });
    assert({
      given: 'a viewer whose Imago may work in a standard drive',
      should: 'show the Imago access section with its switch on',
      actual: { heading: root.querySelector('h2')?.textContent, checked: switchOf(root)?.getAttribute('aria-checked') },
      expected: { heading: 'Imago access', checked: 'true' },
    });
    click(switchOf(root) as HTMLButtonElement);
    await settle(() => {
      if (switchOf(root)?.getAttribute('aria-checked') !== 'false') throw new Error('not off yet');
    });
    assert({
      given: 'the switch clicked off',
      should: 'write enabled false to the imago-access route and show it off',
      actual: { writes: web.writes().map((request) => request.body), checked: switchOf(root)?.getAttribute('aria-checked') },
      expected: { writes: [{ enabled: false }], checked: 'false' },
    });
  });

  test('a Home drive: no switch, the guard\'s reason instead, and no request for the answer', async () => {
    const web = fakeWeb(server('HOME'));
    const root = mount(
      <ImagoSWRProvider client={web.client}>
        <ImagoAccessSection driveId="d1" />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (!root.textContent?.includes('Home drive')) throw new Error('no reason yet');
    });
    assert({
      given: 'the Home drive',
      should: 'show no switch and ask the route for nothing',
      actual: { switchPresent: switchOf(root) !== null, reads: web.count('GET /api/drives/d1/imago-access') },
      expected: { switchPresent: false, reads: 0 },
    });
  });
});
