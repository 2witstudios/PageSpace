// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '../../test-support/dom';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { taskItem, taskListResponse } from '../task-model/fixtures';
import { TasksPane } from './tasks-pane';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

afterEach(unmountAll);

const DRIVE = 'GET /api/drives/d1/pages?ls=true&recursive=true';

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

describe('TasksPane beside an open task', () => {
  test('the task’s list, its tasks by status, the open one current', async () => {
    const web = fakeWeb({
      [DRIVE]: () =>
        Response.json({
          mode: 'ls',
          pages: [
            { id: 'l1', title: 'Launch', type: 'TASK_LIST', hasChildren: true, isTaskLinked: false },
            { id: 'page-p', title: 'Plan launch', type: 'TASK_LIST', hasChildren: true, isTaskLinked: true },
          ],
        }),
      'GET /api/pages/page-p/breadcrumbs': () =>
        Response.json([
          { id: 'l1', title: 'Launch', type: 'TASK_LIST', parentId: null, driveId: 'd1', drive: null },
          { id: 'page-p', title: 'Plan launch', type: 'TASK_LIST', parentId: 'l1', driveId: 'd1', drive: null },
        ]),
      'GET /api/pages/l1/tasks?limit=200&offset=0': () =>
        Response.json(
          taskListResponse([
            taskItem('p', { title: 'Plan launch', status: 'in_progress', position: 0, subTaskCount: 0 }),
            taskItem('z', { title: 'Book venue', status: 'pending', position: 1 }),
          ]),
        ),
      'GET /api/pages/page-p/tasks?limit=200&offset=0': () => Response.json(taskListResponse([])),
    });
    const container = mount(
      <ImagoSWRProvider client={web.client}>
        <TasksPane driveId="d1" selectedPageId="page-p" />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (!container.querySelector('[aria-label="To Do"]')) throw new Error('not loaded');
    });
    const current = container.querySelector('[aria-current="page"]');
    assert({
      given: 'an open task in list Launch, beside the list’s tasks',
      should: 'list the tasks by status with the open one highlighted and a way back to the list',
      actual: {
        groups: [...container.querySelectorAll('section[aria-label]')].map((group) => group.getAttribute('aria-label')),
        current: current?.textContent,
        currentHref: current?.getAttribute('href'),
        back: container.querySelector('a[href="/d1/tasks/l1"]')?.textContent?.includes('Launch'),
        listsHidden: container.querySelector('[aria-label="Task lists"]') === null,
      },
      expected: {
        groups: ['To Do', 'In Progress'],
        current: 'Plan launch',
        currentHref: '/d1/tasks/page-p',
        back: true,
        listsHidden: true,
      },
    });
  });
});
