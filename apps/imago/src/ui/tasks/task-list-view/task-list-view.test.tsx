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

const open = async (viewerId = 'u-1', table: Record<string, FakeRoute> = routes()) => {
  const web = fakeWeb(table);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <TaskListView driveId="d1" pageId="l1" viewerId={viewerId} />
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

  test('a list that will not load', async () => {
    const web = fakeWeb({
      ...routes(),
      [L1]: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const container = mount(
      <ImagoSWRProvider client={web.client}>
        <TaskListView driveId="d1" pageId="l1" viewerId="u-1" />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (!container.querySelector('[role="alert"]')) throw new Error('no alert');
    });
    assert({
      given: 'a list the server refuses',
      should: 'say it could not load',
      actual: container.querySelector('[role="alert"]')?.textContent,
      expected: 'Could not load this task list.',
    });
  });
});
