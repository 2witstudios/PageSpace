// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { click, mount, unmountAll } from '../../test-support/dom';
import { fakeRealtime } from '../../test-support/fake-realtime';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { createInitialState } from '../../store/state';
import { setUiState } from '../../store/store';
import { treeRow } from '../file-model/fixtures';
import { FilesPane } from './files-pane';

beforeEach(() => setUiState(createInitialState()));
afterEach(unmountAll);

const TREE = 'GET /api/drives/d1/pages';

const show = (routes: Record<string, FakeRoute>) => {
  const web = fakeWeb(routes);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={fakeRealtime().client}>
        <FilesPane driveId="d1" rows={<li data-rows="">the tree</li>} />
      </RealtimeProvider>
    </ImagoSWRProvider>,
  );
  return { web, container };
};

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

describe('FilesPane', () => {
  test('a drive with no pages', async () => {
    const { container } = show({ [TREE]: () => Response.json([]) });
    await settle(() => {
      if (!container.querySelector('[data-empty]')) throw new Error('not loaded');
    });
    assert({
      given: 'an empty drive',
      should: 'draw the designed empty object in the list, and no rows',
      actual: [
        [...(container.querySelector('[data-empty]')?.children ?? [])].map((child) => child.textContent),
        container.querySelector('[data-rows]'),
      ],
      expected: [['No pages yet', 'Pages in this drive show up here.'], null],
    });
  });

  test('a drive with pages', async () => {
    const { container } = show({ [TREE]: () => Response.json([treeRow('p1', 'DOCUMENT')]) });
    await settle(() => {
      if (!container.querySelector('[data-rows]')) throw new Error('not loaded');
    });
    assert({
      given: 'a drive with a page',
      should: 'draw the rows it was given and no edge state',
      actual: container.querySelector('[data-empty], [data-error], [role="status"]'),
      expected: null,
    });
  });

  test('while the tree loads', () => {
    const { container } = show({ [TREE]: () => new Promise<Response>(() => {}) });
    assert({
      given: 'a tree still on its way',
      should: 'say so',
      actual: container.querySelector('[role="status"]')?.textContent,
      expected: 'Loading pages…',
    });
  });

  test('a tree that will not load, then loads', async () => {
    let calls = 0;
    const { container, web } = show({
      [TREE]: () => {
        calls += 1;
        return calls === 1 ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json([]);
      },
    });
    await settle(() => {
      if (!container.querySelector('[role="alert"] button')) throw new Error('no retry');
    });
    const title = container.querySelector('[role="alert"] h2')?.textContent;
    click(container.querySelector('[role="alert"] button') as HTMLButtonElement);
    await settle(() => {
      if (!container.querySelector('[data-empty]')) throw new Error('not reloaded');
    });
    assert({
      given: 'a failed load, then Try again',
      should: 'draw the retryable error, then what SWR loads on retry',
      actual: [title, web.count(TREE)],
      expected: ['Could not load pages', 2],
    });
  });
});
