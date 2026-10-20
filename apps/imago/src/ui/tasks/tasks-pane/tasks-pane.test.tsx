// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { taskItem, taskListResponse } from '../task-model/fixtures';
import type { DriveTaskResponse } from '../task-model/task';
import { NewTaskListAction, TasksPane } from './tasks-pane';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

afterEach(() => {
  unmountAll();
});

const COUNT = (filter = '') => `GET /api/tasks?context=drive&driveId=d1&limit=1${filter}`;

const DRIVE = 'GET /api/drives/d1/pages?ls=true&recursive=true';

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

const lists = (pages: readonly { id: string; title: string; isTaskLinked?: boolean }[]) => () =>
  Response.json({
    mode: 'ls',
    pages: pages.map(({ id, title, isTaskLinked = false }) => ({
      id,
      title,
      type: 'TASK_LIST',
      hasChildren: false,
      isTaskLinked,
    })),
  });

/** The viewer's open tasks in the drive, as the Needs attention glance reads them. */
const ACTIVE = 'GET /api/tasks?context=drive&driveId=d1&limit=100&statusGroup=active';

const show = (routes: Record<string, FakeRoute>, selectedPageId: string | null = null, selectedViewId: string | null = null) => {
  const web = fakeWeb(routes);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <TasksPane driveId="d1" selectedPageId={selectedPageId} selectedViewId={selectedViewId} />
    </ImagoSWRProvider>,
  );
  return { web, container };
};

describe('TasksPane', () => {
  test('New list in the head makes a task list and opens it', async () => {
    const web = fakeWeb({
      [DRIVE]: lists([]),
      'POST /api/pages': () => Response.json({ id: 'n1', title: 'Untitled Task List', type: 'TASK_LIST', parentId: null, position: 0, isTrashed: false, updatedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z' }),
    });
    const container = mount(
      <ImagoSWRProvider client={web.client}>
        <NewTaskListAction driveId="d1" />
      </ImagoSWRProvider>,
    );
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="New list"]');
    await act(async () => {
      button?.click();
    });
    await settle(() => {
      assert({
        given: 'New list in the Tasks pane',
        should: 'POST an untitled task list at the drive top and open it',
        actual: { body: web.writes()[0]?.body, opened: router.push.mock.calls.at(-1)?.[0] },
        expected: { body: { title: 'Untitled Task List', type: 'TASK_LIST', driveId: 'd1', parentId: null }, opened: '/d1/tasks/n1' },
      });
    });
  });

  test('a drive’s lists with progress', async () => {
    const { container } = show(
      {
        [DRIVE]: lists([
          { id: 'l1', title: 'Launch' },
          { id: 't1', title: 'A task’s own page', isTaskLinked: true },
          { id: 'l2', title: 'Errands' },
        ]),
        'GET /api/pages/l1/tasks?limit=200&offset=0': () =>
          Response.json(
            taskListResponse([
              taskItem('p', { status: 'completed', position: 0 }),
              taskItem('q', { position: 1 }),
              taskItem('r', { status: 'in_progress', position: 2 }),
            ]),
          ),
        'GET /api/pages/l2/tasks?limit=200&offset=0': () => Response.json(taskListResponse([])),
      },
      'l1',
    );
    await settle(() => {
      if (container.querySelectorAll('[role="progressbar"]').length < 1) throw new Error('no progress');
      if (!container.textContent?.includes('No tasks')) throw new Error('l2 not loaded');
    });
    const links = [...container.querySelectorAll('[aria-label="Task lists"] a')];
    assert({
      given: 'a drive with two task lists (and a task’s own page)',
      should: 'list only the lists, each linking to its tasks route with its progress, the open one current',
      actual: {
        group: [...container.querySelectorAll('section')].map((section) => section.getAttribute('aria-label')),
        links: links.map((link) => [link.textContent?.includes('Launch') ? 'Launch' : 'Errands', link.getAttribute('href')]),
        current: links.map((link) => link.getAttribute('aria-current')),
        progress: [...container.querySelectorAll('[role="progressbar"]')].map((bar) => bar.getAttribute('aria-label')),
      },
      expected: {
        group: ['Views', 'Task lists'],
        links: [
          ['Launch', '/d1/tasks/l1'],
          ['Errands', '/d1/tasks/l2'],
        ],
        current: ['page', null],
        progress: ['Launch: 1 of 3 tasks done'],
      },
    });
  });

  test('no lists', async () => {
    const { container } = show({ [DRIVE]: lists([]) });
    await settle(() => {
      if (!container.querySelector('[data-empty]')) throw new Error('not loaded');
    });
    assert({
      given: 'a drive with no task lists',
      should: 'draw the designed empty object, saying what will show up',
      actual: [...(container.querySelector('[data-empty]')?.children ?? [])].map((child) => child.textContent),
      expected: ['No task lists yet', 'Task lists in this drive show up here.'],
    });
  });

  test('lists that will not load', async () => {
    const { container } = show({
      [DRIVE]: () => Response.json({ error: 'relation "pages" does not exist' }, { status: 500 }),
    });
    await settle(() => {
      if (!container.querySelector('[role="alert"]')) throw new Error('no alert');
    });
    const alert = container.querySelector('[role="alert"]');
    assert({
      given: 'a drive whose lists fail with server text in the answer',
      should: 'draw the retryable error object without the server’s text',
      actual: {
        title: alert?.querySelector('h2')?.textContent,
        button: alert?.querySelector('button')?.textContent,
        leaks: alert?.textContent?.includes('relation') ?? true,
      },
      expected: { title: 'Could not load task lists', button: 'Try again', leaks: false },
    });
  });

  test('Try again after a failure', async () => {
    let calls = 0;
    const { web, container } = show({
      [DRIVE]: () => {
        calls += 1;
        return calls === 1
          ? Response.json({ error: 'Unavailable' }, { status: 503 })
          : lists([{ id: 'l1', title: 'Launch' }])();
      },
      'GET /api/pages/l1/tasks?limit=200&offset=0': () => Response.json(taskListResponse([])),
    });
    await settle(() => {
      if (!container.querySelector('[role="alert"] button')) throw new Error('no retry');
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    });
    await settle(() => {
      if (!container.textContent?.includes('Launch')) throw new Error('not reloaded');
    });
    assert({
      given: 'a failed load, then Try again',
      should: 'ask the server again through SWR and draw the lists it answers',
      actual: { asked: web.count(DRIVE), alert: container.querySelector('[role="alert"]') === null },
      expected: { asked: 2, alert: true },
    });
  });

  test('smart views with their counts, each opening its tasks in the middle', async () => {
    const counted = (total: number) => () => Response.json({ tasks: [], pagination: { total, limit: 1, offset: 0, hasMore: false } });
    const { container } = show(
      {
        [DRIVE]: lists([]),
        [COUNT()]: counted(6),
        [COUNT('&dueDateFilter=overdue')]: counted(1),
        [COUNT('&dueDateFilter=today')]: counted(2),
        [COUNT('&dueDateFilter=this_week')]: counted(4),
        [COUNT('&dueDateFilter=upcoming')]: counted(1),
      },
      null,
      'overdue',
    );
    await settle(() => {
      if (!container.textContent?.includes('Upcoming1')) throw new Error('counts not loaded');
    });
    const views = [...container.querySelectorAll<HTMLAnchorElement>('[aria-label="Views"] a')];
    assert({
      given: 'the five views with their counts, with Overdue open in the middle',
      should: 'link each view to its own address and mark the open one current',
      actual: views.map((view) => [view.textContent, view.getAttribute('href'), view.getAttribute('aria-current')]),
      expected: [
        ['Assigned to me6', '/d1/tasks/view/assigned', null],
        ['Overdue1', '/d1/tasks/view/overdue', 'page'],
        ['Due today2', '/d1/tasks/view/today', null],
        ['This week4', '/d1/tasks/view/this_week', null],
        ['Upcoming1', '/d1/tasks/view/upcoming', null],
      ],
    });
  });

  test('Needs attention, at a glance beside the chat', async () => {
    const day = (offset: number): string => {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T12:00:00.000Z`;
    };
    const task = (id: string, title: string, dueDate: string | null): DriveTaskResponse => ({
      ...taskItem(id, { title, dueDate }),
      driveId: 'd1',
      taskListPageId: 'l1',
      taskListPageTitle: 'Launch',
      statusGroup: 'todo',
      statusLabel: 'To Do',
      statusColor: '',
    });
    const { container } = show({
      [DRIVE]: lists([]),
      [ACTIVE]: () =>
        Response.json({
          tasks: [task('a', 'Ship it', day(-2)), task('b', 'Someday', day(60)), task('c', 'Undated', null)],
          pagination: { total: 3, limit: 100, offset: 0, hasMore: false },
        }),
    });
    await settle(() => {
      if (!container.querySelector('[aria-label="Needs attention"]')) throw new Error('glance not loaded');
    });
    assert({
      given: 'an overdue task, one due in two months and one with no date',
      should: 'show only the overdue one, linking to its task',
      actual: [...container.querySelectorAll('[aria-label="Needs attention"] li a')].map((link) => [
        link.textContent?.startsWith('Ship it'),
        link.getAttribute('href'),
      ]),
      expected: [[true, `/d1/tasks/${taskItem('a').pageId}`]],
    });
  });

  test('See all opens a view that holds every task the glance draws from', async () => {
    const overdue = Array.from({ length: 8 }, (_, index) => ({
      ...taskItem(`o${index}`, { title: `Late ${index}`, dueDate: '2020-01-01T12:00:00.000Z' }),
      driveId: 'd1',
      taskListPageId: 'l1',
      taskListPageTitle: 'Launch',
      statusGroup: 'todo' as const,
      statusLabel: 'To Do',
      statusColor: '',
    }));
    const { container } = show({
      [DRIVE]: lists([]),
      [ACTIVE]: () => Response.json({ tasks: overdue, pagination: { total: 8, limit: 100, offset: 0, hasMore: false } }),
    });
    await settle(() => {
      if (!container.querySelector('[aria-label="Needs attention"]')) throw new Error('glance not loaded');
    });
    const seeAll = [...container.querySelectorAll('[aria-label="Needs attention"] > a')].at(-1);
    assert({
      given: 'more overdue tasks than the glance shows',
      should: 'link See all to Assigned to me, which holds overdue and this week alike, never This week alone',
      actual: [seeAll?.textContent, seeAll?.getAttribute('href')],
      expected: ['See all 8', '/d1/tasks/view/assigned'],
    });
  });
});
