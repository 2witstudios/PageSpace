// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { click, mount, press, typeInto, unmountAll } from '../../test-support/dom';
import { createInitialState } from '../../store/state';
import { setUiState } from '../../store/store';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { taskItem, taskListResponse } from '../task-model/fixtures';
import { TaskListView } from './task-list-view';

const DRIVE = 'GET /api/drives/d1/pages?ls=true&recursive=true';
const L1 = 'GET /api/pages/l1/tasks?limit=200&offset=0';
const PAGE_P = 'GET /api/pages/page-p/tasks?limit=200&offset=0';

/** Drive d1 holds list l1 "Launch": parent p (open subtask a) and leaf z. */
const routes = (overrides: Record<string, FakeRoute> = {}): Record<string, FakeRoute> => ({
  [DRIVE]: () =>
    Response.json({
      mode: 'ls',
      pages: [{ id: 'l1', title: 'Launch', type: 'TASK_LIST', hasChildren: true, isTaskLinked: false }],
    }),
  [L1]: () =>
    Response.json(
      taskListResponse([
        taskItem('p', { title: 'Plan launch', subTaskCount: 1, position: 0 }),
        taskItem('z', { title: 'Book venue', position: 1 }),
      ]),
    ),
  [PAGE_P]: () => Response.json(taskListResponse([taskItem('a', { title: 'Draft copy' })])),
  ...overrides,
});

beforeEach(() => {
  setUiState(createInitialState());
  localStorage.clear();
});

afterEach(unmountAll);

/**
 * Waits for `check` to pass, letting React flush between tries: an update
 * made inside one long act() would only land when that act ended.
 */
const settle = async (check: () => void): Promise<void> => {
  for (let tries = 0; tries < 100; tries += 1) {
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

/**
 * The injected clock: local noon on 14 March 2025, whatever the zone. A day
 * long past, so a view that read the machine's clock instead would fail.
 */
const NOON = new Date(2025, 2, 14, 12);
const clock = () => NOON;
const todayAt = (hour: number) => new Date(2025, 2, 14, hour).toISOString();
const yesterday = new Date(2025, 2, 13, 12).toISOString();

const open = async (viewerId = 'u-1', table: Record<string, FakeRoute> = routes()) => {
  const web = fakeWeb(table);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <TaskListView driveId="d1" pageId="l1" viewerId={viewerId} clock={clock} />
    </ImagoSWRProvider>,
  );
  await settle(() => {
    // Loaded: titled, and the body is no longer the loading message.
    if (container.querySelector('h2')?.textContent !== 'Launch') throw new Error('no title');
    if (container.textContent?.includes('Loading tasks…')) throw new Error('not loaded');
  });
  return { web, container };
};

const radio = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent === name);

const checked = (container: HTMLElement) =>
  container.querySelector('[role="radio"][aria-checked="true"]')?.textContent;

describe('TaskListView', () => {
  test('an open list', async () => {
    const { container } = await open();
    assert({
      given: 'a task list opened in a drive',
      should: 'title it, meter every loaded task and show the Tree view by default',
      actual: {
        title: container.querySelector('h2')?.textContent,
        progress: container.querySelector('[role="progressbar"]')?.getAttribute('aria-label'),
        view: checked(container),
        group: container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label'),
        tree: container.querySelector('ul')?.getAttribute('aria-label'),
      },
      expected: {
        title: 'Launch',
        progress: '0 of 3 tasks done',
        view: 'Tree',
        group: 'View',
        tree: 'Launch tasks',
      },
    });
  });

  test('ticking a task', async () => {
    let served = 'pending';
    const { web, container } = await open('u-1', {
      ...routes(),
      [L1]: () =>
        Response.json(
          taskListResponse([
            taskItem('p', { title: 'Plan launch', subTaskCount: 1, position: 0 }),
            taskItem('z', { title: 'Book venue', position: 1, status: served }),
          ]),
        ),
      'PATCH /api/pages/l1/tasks/z': ({ body }) => {
        served = (body as { status: string }).status;
        return Response.json(taskItem('z', { status: served }));
      },
    });
    const box = () => container.querySelector('[aria-label="Complete Book venue"]');
    click(box() as HTMLButtonElement);
    await settle(() => {
      if (box()?.getAttribute('aria-checked') !== 'true') throw new Error('not ticked');
    });
    assert({
      given: 'a leaf ticked in the Tree view',
      should: 'PATCH it to the list’s done status with the CSRF token and show it done',
      actual: { writes: web.writes(), checked: box()?.getAttribute('aria-checked') },
      expected: {
        writes: [{ method: 'PATCH', url: '/api/pages/l1/tasks/z', csrf: 'tok-1', body: { status: 'completed' } }],
        checked: 'true',
      },
    });
  });

  test('a parent with an open subtask', async () => {
    const { web, container } = await open();
    click(container.querySelector('[aria-label="Complete Plan launch"]') as HTMLButtonElement);
    await settle(() => {
      if (!container.querySelector('[role="status"]')) throw new Error('no notice');
    });
    assert({
      given: 'a parent ticked while its subtask is open',
      should: 'refuse under its row in the server’s words, leave it open and write nothing',
      actual: {
        notice: container.querySelector('li[data-task="p"] > [role="status"]')?.textContent,
        checked: container.querySelector('[aria-label="Complete Plan launch"]')?.getAttribute('aria-checked'),
        writes: web.writes().length,
      },
      expected: {
        notice: 'Complete all sub-tasks first (1 of 1 remaining)',
        checked: 'false',
        writes: 0,
      },
    });
  });

  test('expanding and adding a subtask', async () => {
    const { web, container } = await open('u-1', {
      ...routes(),
      'POST /api/pages/page-p/tasks': ({ body }) =>
        Response.json(taskItem('b', { title: (body as { title: string }).title }), { status: 201 }),
    });
    click(container.querySelector('[aria-label="Toggle Plan launch"]') as HTMLButtonElement);
    const shown = container.querySelector('li[data-task="a"]') !== null;
    const add = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Add subtask',
    );
    if (add) click(add);
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Add subtask"]');
    if (field) {
      typeInto(field, 'Proofread');
      press(field, 'Enter');
    }
    await settle(() => {
      if (web.writes().length === 0) throw new Error('not sent');
    });
    assert({
      given: 'a parent expanded, then a subtask added inline',
      should: 'show its subtasks and POST the new one to the parent’s own page',
      actual: { shown, writes: web.writes() },
      expected: {
        shown: true,
        writes: [{ method: 'POST', url: '/api/pages/page-p/tasks', csrf: 'tok-1', body: { title: 'Proofread' } }],
      },
    });
  });

  test('the view choice persists per viewer', async () => {
    const first = await open('u-1');
    click(radio(first.container, 'Board') as HTMLButtonElement);
    const afterChoice = {
      view: checked(first.container),
      stored: localStorage.getItem('imago:task-view:u-1'),
      tree: first.container.querySelector('ul[aria-label="Launch tasks"]') !== null,
    };
    unmountAll();

    // A new visit: a fresh store, as after a reload, reading the same browser.
    setUiState(createInitialState());
    const again = await open('u-1');
    const returning = checked(again.container);
    unmountAll();

    setUiState(createInitialState());
    const other = await open('u-2');
    assert({
      given: 'u-1 choosing Board, then returning; then u-2 on the same browser',
      should: 'save it under u-1, restore it for u-1 and leave u-2 on Tree',
      actual: { afterChoice, returning, other: checked(other.container) },
      expected: {
        afterChoice: { view: 'Board', stored: 'board', tree: false },
        returning: 'Board',
        other: 'Tree',
      },
    });
  });

  describe('Focus', () => {
    /** l1: parent p (open a, d done today), loose open z, loose y done yesterday. */
    const focusRoutes = (served: { extra: ReturnType<typeof taskItem>[] }): Record<string, FakeRoute> => ({
      ...routes(),
      [L1]: () =>
        Response.json(
          taskListResponse([
            taskItem('p', { title: 'Plan launch', subTaskCount: 2, subTaskCompletedCount: 1, position: 0 }),
            taskItem('z', { title: 'Book venue', position: 1 }),
            taskItem('y', { title: 'Old chore', position: 2, status: 'completed', completedAt: yesterday }),
            ...served.extra,
          ]),
        ),
      [PAGE_P]: () =>
        Response.json(
          taskListResponse([
            taskItem('a', { title: 'Draft copy', position: 0 }),
            taskItem('d', { title: 'Pick date', position: 1, status: 'completed', completedAt: todayAt(9) }),
          ]),
        ),
    });

    const groups = (container: HTMLElement) =>
      [...container.querySelectorAll('section')].map((section) => [
        section.getAttribute('aria-label'),
        [...section.querySelectorAll('li[data-task]')].map((row) => row.getAttribute('data-task')),
      ]);

    const toFocus = async (table: Record<string, FakeRoute>) => {
      const opened = await open('u-1', table);
      click(radio(opened.container, 'Focus') as HTMLButtonElement);
      return opened;
    };

    test('open leaves by parent, plus done today', async () => {
      const { container } = await toFocus(focusRoutes({ extra: [] }));
      await settle(() => {
        if (container.querySelectorAll('section').length < 3) throw new Error('no focus');
      });
      assert({
        given: 'Focus chosen on a list loaded from the server, read on the injected clock’s day',
        should: 'list the open leaves under their parent and the list, and only today’s completions as Done today',
        actual: { view: checked(container), groups: groups(container) },
        expected: {
          view: 'Focus',
          groups: [
            ['Plan launch', ['a']],
            ['Launch', ['z']],
            ['Done today', ['d']],
          ],
        },
      });
    });

    test('ticking a leaf', async () => {
      let status = 'pending';
      const table = focusRoutes({ extra: [] });
      const { web, container } = await toFocus({
        ...table,
        [L1]: () =>
          Response.json(
            taskListResponse([
              taskItem('p', { title: 'Plan launch', subTaskCount: 2, subTaskCompletedCount: 1, position: 0 }),
              taskItem('z', {
                title: 'Book venue',
                position: 1,
                status,
                completedAt: status === 'completed' ? todayAt(12) : null,
              }),
            ]),
          ),
        'PATCH /api/pages/l1/tasks/z': ({ body }) => {
          status = (body as { status: string }).status;
          return Response.json(taskItem('z', { status }));
        },
      });
      await settle(() => {
        if (!container.querySelector('[aria-label="Complete Book venue"]')) throw new Error('no row');
      });
      click(container.querySelector('[aria-label="Complete Book venue"]') as HTMLButtonElement);
      await settle(() => {
        if (web.writes().length === 0) throw new Error('not sent');
        if (!container.querySelector('section[aria-label="Done today"] li[data-task="z"]')) throw new Error('not done');
      });
      assert({
        given: 'an open leaf ticked in Focus',
        should: 'PATCH it done with the CSRF token and move it from its group to Done today',
        actual: { writes: web.writes(), groups: groups(container) },
        expected: {
          writes: [{ method: 'PATCH', url: '/api/pages/l1/tasks/z', csrf: 'tok-1', body: { status: 'completed' } }],
          groups: [
            ['Plan launch', ['a']],
            ['Done today', ['d', 'z']],
          ],
        },
      });
    });

    test('capturing a task', async () => {
      const served: { extra: ReturnType<typeof taskItem>[] } = { extra: [] };
      const { web, container } = await toFocus({
        ...focusRoutes(served),
        'POST /api/pages/l1/tasks': ({ body }) => {
          const created = taskItem('n', { title: (body as { title: string }).title, position: 3 });
          served.extra = [created];
          return Response.json(created, { status: 201 });
        },
      });
      await settle(() => {
        if (!container.querySelector('[data-capture] button')) throw new Error('no capture row');
      });
      click(container.querySelector('[data-capture] button') as HTMLButtonElement);
      const field = container.querySelector<HTMLInputElement>('input[aria-label="Add task to Launch"]');
      if (field) {
        typeInto(field, 'Order banners');
        press(field, 'Enter');
      }
      await settle(() => {
        if (!container.querySelector('li[data-task="n"]')) throw new Error('not revalidated');
      });
      assert({
        given: 'a title typed into the capture row of the selected list',
        should: 'POST it to that list with the CSRF token and show it among the list’s open leaves',
        actual: { writes: web.writes(), groups: groups(container) },
        expected: {
          writes: [{ method: 'POST', url: '/api/pages/l1/tasks', csrf: 'tok-1', body: { title: 'Order banners' } }],
          groups: [
            ['Plan launch', ['a']],
            ['Launch', ['z', 'n']],
            ['Done today', ['d']],
          ],
        },
      });
    });

    test('a refused capture', async () => {
      const { container } = await toFocus({
        ...focusRoutes({ extra: [] }),
        'POST /api/pages/l1/tasks': () => Response.json({ error: 'Insufficient permissions' }, { status: 403 }),
      });
      await settle(() => {
        if (!container.querySelector('[data-capture] button')) throw new Error('no capture row');
      });
      click(container.querySelector('[data-capture] button') as HTMLButtonElement);
      const field = container.querySelector<HTMLInputElement>('input[aria-label="Add task to Launch"]');
      if (field) {
        typeInto(field, 'Order banners');
        press(field, 'Enter');
      }
      await settle(() => {
        if (!container.querySelector('[data-capture] [role="status"]')) throw new Error('no notice');
      });
      assert({
        given: 'a capture the server refuses',
        should: 'say why under the capture row and keep the leaves as the server has them',
        actual: {
          notice: container.querySelector('[data-capture] [role="status"]')?.textContent,
          groups: groups(container),
        },
        expected: {
          notice: 'Insufficient permissions',
          groups: [
            ['Plan launch', ['a']],
            ['Launch', ['z']],
            ['Done today', ['d']],
          ],
        },
      });
    });
  });

  const mountList = (table: Record<string, FakeRoute>, pageId = 'l1') => {
    const web = fakeWeb(table);
    const container = mount(
      <ImagoSWRProvider client={web.client}>
        <TaskListView driveId="d1" pageId={pageId} viewerId="u-1" />
      </ImagoSWRProvider>,
    );
    return { web, container };
  };

  const notFound = (container: HTMLElement) => {
    const object = container.querySelector('[data-not-found]');
    return {
      title: object?.querySelector('h2')?.textContent,
      link: object?.querySelector('a')?.getAttribute('href'),
      label: object?.querySelector('a')?.textContent,
    };
  };

  test('a list the server refuses', async () => {
    const { container } = mountList({
      ...routes(),
      [L1]: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
    });
    await settle(() => {
      if (!container.querySelector('[data-not-found]')) throw new Error('no not-found');
    });
    assert({
      given: 'a list id the server answers 403 for',
      should: 'draw the not-found object with a way back to the drive’s task lists',
      actual: notFound(container),
      expected: { title: 'Task list not found', link: '/d1/tasks', label: 'Back to Tasks' },
    });
  });

  test('an id that is not one of the drive’s lists', async () => {
    const { container } = mountList(
      { ...routes(), 'GET /api/pages/nope/tasks?limit=200&offset=0': () => Response.json(taskListResponse([])) },
      'nope',
    );
    await settle(() => {
      if (!container.querySelector('[data-not-found]')) throw new Error('no not-found');
    });
    assert({
      given: 'a page id the drive does not list as a task list',
      should: 'draw the not-found object, not an empty list',
      actual: notFound(container).title,
      expected: 'Task list not found',
    });
  });

  test('a list that will not load, then loads', async () => {
    let calls = 0;
    const table = routes();
    const { web, container } = mountList({
      ...table,
      [L1]: (request) => {
        calls += 1;
        return calls === 1 ? Response.json({ error: 'pg: timeout at db-7' }, { status: 503 }) : table[L1](request);
      },
    });
    await settle(() => {
      if (!container.querySelector('[role="alert"] button')) throw new Error('no retry');
    });
    const alert = container.querySelector('[role="alert"]');
    const failed = {
      title: alert?.querySelector('h2')?.textContent,
      leaks: alert?.textContent?.includes('db-7') ?? true,
    };
    act(() => {
      alert?.querySelector<HTMLButtonElement>('button')?.click();
    });
    await settle(() => {
      if (container.querySelector('ul')?.getAttribute('aria-label') !== 'Launch tasks') throw new Error('not reloaded');
    });
    assert({
      given: 'a 503 with server text, then Try again',
      should: 'draw the retryable error without that text, then the list SWR loads on retry',
      actual: { failed, asked: web.count(L1) >= 2, alert: container.querySelector('[role="alert"]') === null },
      expected: { failed: { title: 'Could not load this task list', leaks: false }, asked: true, alert: true },
    });
  });
});
