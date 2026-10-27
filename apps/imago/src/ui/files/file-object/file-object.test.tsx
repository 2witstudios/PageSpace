// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import type { RealtimeClient, RealtimeSocket } from '@/realtime/realtime-client';
import { mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { createInitialState } from '../../store/state';
import { setUiState } from '../../store/store';
import { treeRow } from '../file-model/fixtures';
import { PageObject } from '../page-object/page-object';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

const { FileObject } = await import('./file-object');

beforeEach(() => setUiState(createInitialState()));

afterEach(unmountAll);

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 2000, interval: 5 }));

/** A socket that never delivers: these tests are about what opens, not liveness. */
const quietRealtime = (): RealtimeClient => {
  const socket: RealtimeSocket = {
    connected: true,
    emit: () => socket,
    on: () => socket,
    off: () => socket,
    connect: () => socket,
    disconnect: () => socket,
  };
  return { socket: () => socket, disconnect: () => {} };
};

const TREE = 'GET /api/drives/d1/pages';

const page = (id: string, type: string): FakeRoute => () =>
  Response.json({ id, title: `Title ${id}`, type, driveId: 'd1', isTrashed: false });

const tree = () => [
  treeRow('f1', 'FOLDER', [treeRow('doc', 'DOCUMENT', [], { parentId: 'f1', title: 'Doc' })], { title: 'Folder' }),
];

/** The route's object slot as it composes: the gate, then the switch, then the page's own view. */
const show = (routes: Record<string, FakeRoute>, pageId: string) => {
  const web = fakeWeb(routes);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={quietRealtime()}>
        <PageObject driveId="d1" pageId={pageId}>
          <FileObject driveId="d1" pageId={pageId}>
            <p data-page-content="">the page</p>
          </FileObject>
        </PageObject>
      </RealtimeProvider>
    </ImagoSWRProvider>,
  );
  return { web, container };
};

describe('FileObject', () => {
  test('a folder', async () => {
    const { web, container } = show({ 'GET /api/pages/f1': page('f1', 'FOLDER'), [TREE]: () => Response.json(tree()) }, 'f1');
    await settle(() => {
      if (container.querySelector('table') === null) throw new Error('no browser yet');
    });
    assert({
      given: 'a FOLDER page opened as the object',
      should: 'open it in the folder browser, not the page view, asking for the page once (the gate’s answer)',
      actual: [
        container.querySelector('section')?.getAttribute('aria-label'),
        container.querySelector('[data-page-content]'),
        web.count('GET /api/pages/f1'),
      ],
      expected: ['Folder', null, 1],
    });
  });

  test('any other page', async () => {
    const { web, container } = show({ 'GET /api/pages/doc': page('doc', 'DOCUMENT') }, 'doc');
    await settle(() => {
      if (container.querySelector('[data-page-content]') === null) throw new Error('not shown');
    });
    assert({
      given: 'a DOCUMENT page opened as the object',
      should: 'draw the page’s own view and leave the drive tree alone',
      actual: [container.querySelector('table'), web.count(TREE)],
      expected: [null, 0],
    });
  });
});
