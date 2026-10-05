// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { taskItem, taskListResponse } from '../task-model/fixtures';
import { TasksPane } from './tasks-pane';

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
      if (!container.textContent?.includes('No task lists')) throw new Error('not loaded');
    });
    assert({
      given: 'a drive with no task lists',
      should: 'say so',
      actual: container.querySelector('p')?.textContent,
      expected: 'No task lists in this drive yet.',
    });
  });

  test('lists that will not load', async () => {
    const { container } = show({ [DRIVE]: () => Response.json({ error: 'Forbidden' }, { status: 403 }) });
    await settle(() => {
      if (!container.querySelector('[role="alert"]')) throw new Error('no alert');
    });
    assert({
      given: 'a drive the server will not list',
      should: 'say the lists could not load',
      actual: container.querySelector('[role="alert"]')?.textContent,
      expected: 'Could not load task lists.',
    });
  });
});
