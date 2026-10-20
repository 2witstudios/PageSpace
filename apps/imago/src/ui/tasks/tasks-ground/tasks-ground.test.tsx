// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { act } from 'react';
import { click, mount, unmountAll } from '../../test-support/dom';
import { taskItem } from '../task-model/fixtures';
import type { DriveTaskResponse, StatusGroupFilter } from '../task-model/task';
import type { ActionResult } from '../use-tasks/use-tasks';

const asked = vi.hoisted((): StatusGroupFilter[] => []);
const toggled = vi.hoisted((): string[] => []);
const answer = vi.hoisted(() => ({ result: { ok: true } as ActionResult }));

const tasks: DriveTaskResponse[] = [
  {
    ...taskItem('t1', { title: 'Write brief' }),
    driveId: 'd1',
    taskListPageId: 'l1',
    taskListPageTitle: 'Launch',
    statusGroup: 'todo',
    statusLabel: 'To Do',
    statusColor: '',
  },
];

vi.mock('../use-tasks/use-tasks', () => ({
  useDriveTasks: (_driveId: string, status: StatusGroupFilter) => {
    asked.push(status);
    return {
      response: { tasks, pagination: { total: 1, limit: 100, offset: 0, hasMore: false } },
      error: undefined,
      isLoading: false,
      retry: () => undefined,
      toggleComplete: async (taskId: string) => {
        toggled.push(taskId);
        return answer.result;
      },
    };
  },
}));

const { STATUS_KEY, TasksGround, storedStatus } = await import('./tasks-ground');

beforeEach(() => {
  localStorage.clear();
  asked.length = 0;
  toggled.length = 0;
  answer.result = { ok: true };
});

afterEach(unmountAll);

const flush = () => act(async () => {});

const button = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === label) as HTMLButtonElement;

describe('TasksGround', () => {
  test('the status group is remembered per viewer', async () => {
    localStorage.setItem(STATUS_KEY, 'completed');
    const container = mount(<TasksGround driveId="d1" />);
    await flush();
    const restored = asked.at(-1);
    click(button(container, 'All'));
    assert({
      given: 'Completed kept from a past visit, then All chosen',
      should: 'open on Completed and keep All for next time',
      actual: { restored, now: asked.at(-1), kept: localStorage.getItem(STATUS_KEY) },
      expected: { restored: 'completed', now: 'all', kept: 'all' },
    });
  });

  test('storedStatus()', () => {
    localStorage.setItem(STATUS_KEY, 'sideways');
    const junk = storedStatus();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const blocked = storedStatus();
    getItem.mockRestore();
    assert({
      given: 'a value that is not a status group, and storage that throws',
      should: 'fall back to Active',
      actual: [junk, blocked],
      expected: ['active', 'active'],
    });
  });

  test('ticking a row, and a refusal', async () => {
    const container = mount(<TasksGround driveId="d1" />);
    const box = () => container.querySelector<HTMLButtonElement>('[aria-label="Complete Write brief"]') as HTMLButtonElement;
    click(box());
    await flush();
    const quiet = container.querySelector('[role="status"]');
    answer.result = { ok: false, refusal: 'Complete all sub-tasks first' };
    click(box());
    await flush();
    assert({
      given: 'a row ticked, then ticked again and refused',
      should: 'toggle that task each time and say the refusal under the row',
      actual: { toggled, quiet, notice: container.querySelector('[role="status"]')?.textContent },
      expected: { toggled: ['t1', 't1'], quiet: null, notice: 'Complete all sub-tasks first' },
    });
  });
});
