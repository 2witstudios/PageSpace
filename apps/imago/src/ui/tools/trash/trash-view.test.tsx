// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { click, mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { TrashView } from './trash-view';
import { withoutPage, type TrashPage } from './trash-model';

afterEach(unmountAll);

const page = (overrides: Partial<TrashPage> & Pick<TrashPage, 'id' | 'title'>): TrashPage => ({
  type: 'DOCUMENT',
  parentId: null,
  originalParentId: null,
  position: 0,
  trashedAt: null,
  children: [],
  ...overrides,
});

const TREE: TrashPage[] = [
  page({
    id: 'f1',
    title: 'Old pricing draft',
    type: 'FOLDER',
    originalParentId: 'launch',
    trashedAt: new Date().toISOString(),
    children: [
      page({ id: 'c1', title: 'Tier sketch', type: 'SHEET', parentId: 'f1', trashedAt: null }),
      page({ id: 'c2', title: 'Notes from call', parentId: 'f1', trashedAt: null }),
    ],
  }),
  page({
    id: 'b1',
    title: 'launch-banner@2x.png',
    type: 'FILE',
    fileSize: 1887436,
    originalParentId: 'launch',
    trashedAt: new Date().toISOString(),
  }),
];

/** apps/web's trash routes over a little state: a restore or a delete changes what the next GET answers. */
const server = (overrides: Record<string, FakeRoute> = {}) => {
  let trash: readonly TrashPage[] = TREE;
  return {
    'GET /api/drives/d1/trash': () => Response.json(trash),
    'GET /api/drives/d1/pages?ls=true&recursive=true': () =>
      Response.json({ mode: 'ls', pages: [{ id: 'launch', title: 'Launch', type: 'FOLDER', hasChildren: true, isTaskLinked: false }] }),
    'GET /api/drives': () => Response.json([{ id: 'd1', name: 'Studio', kind: 'STANDARD' }]),
    'POST /api/pages/b1/restore': () => {
      trash = withoutPage(trash, 'b1');
      return Response.json({ success: true });
    },
    'DELETE /api/trash/f1': () => {
      trash = withoutPage(trash, 'f1');
      return Response.json({ success: true });
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
      // Not yet: flush again.
    }
  }
  check();
};

const open = async (routes: Record<string, FakeRoute>, filter: 'all' | 'pages' | 'files' = 'all') => {
  const web = fakeWeb(routes);
  const hrefs: string[] = [];
  const root = mount(
    <ImagoSWRProvider client={web.client}>
      <TrashView driveId="d1" filter={filter} onFilterChange={(href) => hrefs.push(href)} />
    </ImagoSWRProvider>,
  );
  await settle(() => {
    if (!root.querySelector('[role="treegrid"], [role="alert"], [data-empty]')) throw new Error('still loading');
  });
  return { web, root, hrefs };
};

const rowOf = (root: ParentNode, title: string) =>
  [...root.querySelectorAll<HTMLElement>('[role="row"]')].find((row) => row.textContent?.includes(title));

const buttonIn = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === label);

describe('TrashView', () => {
  test('draws the Trash heading, its line, and the Type group with a count', async () => {
    const { root } = await open(server());
    assert({
      given: 'a drive with two trashed tops and a folder of two',
      should: 'show the h1, its explanatory line, and the Type group All · 4 / Pages / Files',
      actual: [
        root.querySelector('h1')?.textContent,
        root.textContent?.includes('Pages trashed from Studio, with whatever was inside them.'),
        root.querySelector('[role="group"][aria-label="Type"]')?.textContent,
        root.querySelector('[aria-pressed="true"]')?.textContent,
      ],
      expected: ['Trash', true, 'All · 4PagesFiles', 'All · 4'],
    });
  });

  test('lists trashed pages as a treegrid with the folder children indented under it', async () => {
    const { root } = await open(server());
    const rows = [...root.querySelectorAll<HTMLElement>('[role="row"]')].slice(1);
    assert({
      given: 'the trash tree',
      should: 'render Name, Was in and Trashed columns, with each child one level below its folder',
      actual: [
        root.querySelector('[role="treegrid"]')?.getAttribute('aria-label'),
        [...root.querySelectorAll('[role="columnheader"]')].map((cell) => cell.textContent),
        rows.map((row) => row.getAttribute('aria-level')),
        rowOf(root, 'Tier sketch')?.textContent?.includes('Old pricing draft'),
      ],
      expected: [
        'Trashed pages',
        ['Name', 'Was in', 'Trashed', ''],
        ['1', '2', '2', '1'],
        true,
      ],
    });
  });

  test('restores a top-level page with POST and takes its row away', async () => {
    const { root, web } = await open(server());
    click(buttonIn(rowOf(root, 'launch-banner@2x.png')!, 'Restore')!);
    await settle(() => {
      if (rowOf(root, 'launch-banner@2x.png')) throw new Error('row still there');
    });
    assert({
      given: 'a click on Restore for a top-level file',
      should: 'POST pages/[pageId]/restore once and remove the row',
      actual: [web.writes().map((request) => `${request.method} ${request.url}`), rowOf(root, 'launch-banner@2x.png')],
      expected: [['POST /api/pages/b1/restore'], undefined],
    });
  });

  test('opens an inline alertdialog for Delete forever and cancels without a request', async () => {
    const { root, web } = await open(server());
    click(root.querySelector<HTMLButtonElement>('[aria-label="Delete Old pricing draft forever"]')!);
    const dialog = root.querySelector<HTMLElement>('[role="alertdialog"]');
    click(buttonIn(dialog!, 'Cancel')!);
    assert({
      given: 'Delete forever on a folder, then Cancel',
      should: 'confirm with the folder and its two pages, close without a DELETE, and keep the row',
      actual: [
        dialog?.getAttribute('aria-label'),
        dialog?.textContent?.includes('the 2 pages inside it'),
        root.querySelector('[role="alertdialog"]'),
        web.writes().length,
        rowOf(root, 'Old pricing draft') !== undefined,
      ],
      expected: ['Delete Old pricing draft forever', true, null, 0, true],
    });
  });

  test('confirms Delete forever with DELETE trash/[pageId] and takes the folder away', async () => {
    const { root, web } = await open(server());
    click(root.querySelector<HTMLButtonElement>('[aria-label="Delete Old pricing draft forever"]')!);
    click(buttonIn(root.querySelector('[role="alertdialog"]')!, 'Delete forever')!);
    await settle(() => {
      if (rowOf(root, 'Old pricing draft')) throw new Error('folder still there');
    });
    assert({
      given: 'the inline confirm for a folder',
      should: 'DELETE trash/[pageId] and remove the folder with the pages inside it',
      actual: web.writes().map((request) => `${request.method} ${request.url}`),
      expected: ['DELETE /api/trash/f1'],
    });
  });

  test('filters by Type through the URL, showing only files under Files', async () => {
    const { root, hrefs } = await open(server(), 'files');
    click(buttonIn(root.querySelector('[role="group"][aria-label="Type"]')!, 'Pages')!);
    assert({
      given: 'the Files filter on, then a click on Pages',
      should: 'keep only the file row under Files and ask for ?type=pages when Pages is chosen',
      actual: [
        [...root.querySelectorAll('[role="row"]')].slice(1).map((row) => row.textContent?.includes('launch-banner')),
        hrefs,
      ],
      expected: [[true], ['/d1/trash?type=pages']],
    });
  });

  test('shows the 403 refusal as an edge state rather than an empty list', async () => {
    const { root } = await open(
      server({
        'GET /api/drives/d1/trash': () =>
          Response.json({ error: 'Only drive owners and admins can view trash' }, { status: 403 }),
      }),
    );
    assert({
      given: 'a member who is not an owner or admin',
      should: 'say who can see the trash, and draw no treegrid',
      actual: [
        root.querySelector('h2')?.textContent,
        root.querySelector('[role="treegrid"]'),
      ],
      expected: ['Only drive owners and admins can see the trash', null],
    });
  });
});
