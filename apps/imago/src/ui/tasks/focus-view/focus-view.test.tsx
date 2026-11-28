// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { act } from 'react';
import { click, mount, unmountAll } from '../../test-support/dom';
import { list, task, taskItem } from '../task-model/fixtures';
import type { DriveTaskResponse, DriveTasksResponse } from '../task-model/task';
import type { ActionResult, TaskActions } from '../use-tasks/use-tasks';

const asked = vi.hoisted((): unknown[][] => []);
const served = vi.hoisted(() => ({ hasMore: false }));

const rows: DriveTaskResponse[] = [
  {
    ...taskItem('d', { title: 'Hire designer' }),
    driveId: 'd1',
    taskListPageId: 'l2',
    taskListPageTitle: 'Hiring',
    statusGroup: 'todo',
    statusLabel: 'To Do',
    statusColor: '',
  },
];

vi.mock('../use-tasks/use-tasks', () => ({
  useDriveTasks: (...args: unknown[]) => {
    asked.push(args);
    const response: DriveTasksResponse = {
      tasks: rows,
      pagination: { total: served.hasMore ? 1500 : 1, limit: 100, offset: 0, hasMore: served.hasMore },
    };
    return {
      response,
      error: undefined,
      isLoading: false,
      retry: () => undefined,
      toggleComplete: async (): Promise<ActionResult> => ({ ok: true }),
    };
  },
}));

const { FocusView } = await import('./focus-view');

beforeEach(() => {
  asked.length = 0;
  served.hasMore = false;
});

afterEach(unmountAll);

const ok = async (): Promise<ActionResult> => ({ ok: true });
const actions: TaskActions = {
  create: ok,
  update: ok,
  setStatus: ok,
  toggleComplete: ok,
  setAssignees: ok,
  toggleAssignee: ok,
  remove: ok,
  move: ok,
  moveTo: ok,
  setWipLimit: ok,
};

const open = list('l1', [task('z', { title: 'Book venue' })], { title: 'Launch' });

const view = (editable: boolean) =>
  mount(<FocusView driveId="d1" list={open} actions={actions} clock={() => new Date(2026, 9, 5, 12)} editable={editable} />);

const boxes = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].map((box) => box.disabled);

const allLists = async (root: HTMLElement) => {
  const scope = [...root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (radio) => radio.textContent === 'All lists',
  );
  if (scope) click(scope);
  await act(async () => {});
};

describe('FocusView', () => {
  test('this list, read-only', () => {
    const root = view(false);
    assert({
      given: 'a viewer who may not edit the open list',
      should: 'show its leaves on disabled checkboxes, with no capture row',
      actual: { boxes: boxes(root), capture: root.querySelector('[data-capture]') },
      expected: { boxes: [true], capture: null },
    });
  });

  test('this list, editable', () => {
    const root = view(true);
    assert({
      given: 'a viewer who may edit the open list',
      should: 'let its leaves be ticked',
      actual: boxes(root),
      expected: [false],
    });
  });

  test('all lists', async () => {
    const root = view(false);
    await allLists(root);
    assert({
      given: 'the drive-wide scope, from a list the viewer may not edit',
      should: 'read every page of the viewer’s open tasks and leave ticking to each list’s own permission',
      actual: { asked: asked.at(-1), boxes: boxes(root), truncated: root.querySelector('[data-truncated]') },
      expected: { asked: ['d1', 'active', undefined, 'every'], boxes: [false], truncated: null },
    });
  });

  test('all lists, past the cap', async () => {
    served.hasMore = true;
    const root = view(true);
    await allLists(root);
    assert({
      given: 'more open tasks than a drive-wide read takes',
      should: 'say the frontier shows only the most recently updated ones',
      actual: root.querySelector('[data-truncated]')?.textContent,
      expected: 'Showing your 1 most recently updated tasks of 1500.',
    });
  });
});
