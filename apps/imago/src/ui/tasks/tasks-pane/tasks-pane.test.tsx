// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { taskItem, taskListResponse } from '../task-model/fixtures';
import { TasksPane } from './tasks-pane';

vi.mock('@/retained-adapters/create-actions', () => ({ CreateActions: () => null }));

afterEach(unmountAll);

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

const show = (routes: Record<string, FakeRoute>, selectedPageId: string | null = null) => {
  const web = fakeWeb(routes);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <TasksPane driveId="d1" selectedPageId={selectedPageId} />
    </ImagoSWRProvider>,
  );
  return { web, container };
};

describe('TasksPane', () => {
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
    const links = [...container.querySelectorAll('a')];
    assert({
      given: 'a drive with two task lists (and a task’s own page)',
      should: 'list only the lists, each linking to its tasks route with its progress, the open one current',
      actual: {
        group: container.querySelector('section')?.getAttribute('aria-label'),
        links: links.map((link) => [link.textContent?.includes('Launch') ? 'Launch' : 'Errands', link.getAttribute('href')]),
        current: links.map((link) => link.getAttribute('aria-current')),
        progress: [...container.querySelectorAll('[role="progressbar"]')].map((bar) => bar.getAttribute('aria-label')),
      },
      expected: {
        group: 'Task lists',
        links: [
          ['Launch', '/d1/tasks/l1'],
          ['Errands', '/d1/tasks/l2'],
        ],
        current: ['page', null],
        progress: ['1 of 3 tasks done'],
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
});
