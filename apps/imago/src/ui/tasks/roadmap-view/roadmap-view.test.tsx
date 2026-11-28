// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, press, unmountAll } from '../../test-support/dom';
import { dueDateFor } from '../task-detail/due-date';
import type { TaskPatch } from '../task-edit/task-edit';
import { list, task } from '../task-model/fixtures';
import type { Task, TaskList } from '../task-model/task';
import type { ActionResult, TaskActions } from '../use-tasks/use-tasks';
import { RoadmapView } from './roadmap-view';

const TODAY = '2026-10-19';

const at = (day: string): string => dueDateFor(day) ?? '';

const dated = (id: string, start: string | null, due: string | null, overrides: Partial<Task> = {}): Task =>
  task(id, {
    startDate: start === null ? null : at(start),
    dueDate: due === null ? null : at(due),
    createdAt: at('2026-10-01'),
    ...overrides,
  });

const launch: TaskList = list(
  'l1',
  [
    {
      ...dated('p', '2026-10-12', '2026-10-23', { title: 'Prepare launch email', status: 'in_progress' }),
      subtasks: list('page-p', [dated('p1', null, '2026-10-15', { title: 'Draft copy' })]),
    },
    dated('q', null, null, { title: 'Book venue' }),
  ],
  { title: 'Launch' },
);

type Call = { readonly taskId: string; readonly patch: TaskPatch };

/** Actions that record every update and answer with `result`. */
const fakeActions = (result: ActionResult = { ok: true }) => {
  const calls: Call[] = [];
  const ok = () => Promise.resolve<ActionResult>({ ok: true });
  const actions: TaskActions = {
    create: ok,
    update: (taskId, patch) => {
      calls.push({ taskId, patch });
      return Promise.resolve(result);
    },
    setStatus: ok,
    toggleComplete: ok,
    setAssignees: ok,
    toggleAssignee: ok,
    remove: ok,
    move: ok,
    moveTo: ok,
    setWipLimit: ok,
  };
  return { actions, calls };
};

const view = (actions: TaskActions, overrides: { readonly editable?: boolean; readonly tasks?: TaskList } = {}) =>
  mount(
    <RoadmapView
      list={overrides.tasks ?? launch}
      actions={actions}
      today={TODAY}
      editable={overrides.editable ?? true}
      taskHref={(entry) => `/tasks/${entry.id}`}
    />,
  );

const find = (root: ParentNode, selector: string): HTMLElement => {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`No ${selector}`);
  return element;
};

const pointer = (target: EventTarget, type: string, clientX: number) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }));
  });

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

beforeEach(() => localStorage.clear());
afterEach(unmountAll);

describe('RoadmapView', () => {
  test('lanes, bars, milestones and the tray', () => {
    const root = view(fakeActions().actions);
    assert({
      given: 'a list with a dated task, its undated-start subtask and an undated task',
      should: 'draw a lane and a named bar or milestone for the dated ones, and tray the other',
      actual: {
        lanes: [...root.querySelectorAll('[data-lane]')].map((lane) => lane.textContent),
        link: root.querySelector('[data-lane="p"] a')?.getAttribute('href'),
        bar: root.querySelector('[data-bar="p"]')?.getAttribute('aria-label'),
        milestone: root.querySelector('[data-milestone="p1"]')?.getAttribute('aria-label'),
        overdue: root.querySelectorAll('[data-overdue]').length,
        tray: [...root.querySelectorAll('[data-unscheduled]')].map((chip) => chip.querySelector('[data-title]')?.textContent),
        timeline: root.querySelector('[data-timeline]')?.getAttribute('aria-label'),
        today: root.querySelectorAll('[data-today]').length,
      },
      expected: {
        lanes: ['Prepare launch email', 'Draft copy'],
        link: '/tasks/p',
        bar: 'Prepare launch email, Oct 12 to Oct 23, In Progress',
        milestone: 'Draft copy, due Oct 15, To Do, overdue',
        overdue: 1,
        tray: ['Book venue'],
        timeline: 'Launch roadmap',
        today: 1,
      },
    });
  });

  test('read-only', () => {
    const root = view(fakeActions().actions, { editable: false });
    assert({
      given: 'a viewer who cannot edit',
      should: 'draw no handles and no Schedule button',
      actual: [root.querySelectorAll('[data-handle]').length, root.textContent?.includes('Schedule')],
      expected: [0, false],
    });
  });

  test('empty', () => {
    const root = view(fakeActions().actions, { tasks: list('l2', [dated('q', null, null, { title: 'Book venue' })]) });
    assert({
      given: 'a list with nothing dated',
      should: 'say so and still tray the tasks',
      actual: [root.textContent?.includes('Nothing scheduled yet.'), root.querySelectorAll('[data-unscheduled]').length],
      expected: [true, 1],
    });
  });

  test('keyboard on a handle', async () => {
    const { actions, calls } = fakeActions();
    const root = view(actions);
    const due = find(root, '[data-bar="p"] [data-handle="due"]');
    press(due, 'ArrowRight');
    const start = find(root, '[data-bar="p"] [data-handle="start"]');
    act(() => {
      start.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
    });
    await flush();
    assert({
      given: 'ArrowRight on the due handle and Shift+ArrowLeft on the start handle',
      should: 'save the due date a day on and the start a week back',
      actual: { calls, label: due.getAttribute('aria-label') },
      expected: {
        calls: [
          { taskId: 'p', patch: { dueDate: at('2026-10-24') } },
          { taskId: 'p', patch: { startDate: at('2026-10-05') } },
        ],
        label: 'Due date of Prepare launch email',
      },
    });
  });

  test('dragging the due edge', async () => {
    const { actions, calls } = fakeActions();
    const root = view(actions);
    const due = find(root, '[data-bar="p"] [data-handle="due"]');
    pointer(due, 'pointerdown', 100);
    pointer(due, 'pointermove', 208);
    const during = {
      ghost: root.querySelectorAll('[data-ghost]').length,
      tooltip: root.querySelector('[data-ghost] [role="status"]')?.textContent,
    };
    pointer(due, 'pointerup', 208);
    await flush();
    assert({
      given: 'the due edge dragged three days on at the Weeks zoom',
      should: 'show a ghost and tooltip while held, then save the new due date',
      actual: { during, after: root.querySelectorAll('[data-ghost]').length, calls },
      expected: {
        during: { ghost: 1, tooltip: 'Due Mon 26 · was Fri 23 · +3d' },
        after: 0,
        calls: [{ taskId: 'p', patch: { dueDate: at('2026-10-26') } }],
      },
    });
  });

  test('moving a bar, and Escape', async () => {
    const { actions, calls } = fakeActions();
    const root = view(actions);
    const bar = find(root, '[data-bar="p"]');
    pointer(bar, 'pointerdown', 100);
    pointer(bar, 'pointermove', 30);
    press(document.body, 'Escape');
    pointer(bar, 'pointerup', 30);
    pointer(bar, 'pointerdown', 100);
    pointer(bar, 'pointermove', 172);
    pointer(bar, 'pointerup', 172);
    await flush();
    assert({
      given: 'a move cancelled with Escape, then a move two days on',
      should: 'save nothing for the first and both dates for the second',
      actual: calls,
      expected: [{ taskId: 'p', patch: { startDate: at('2026-10-14'), dueDate: at('2026-10-25') } }],
    });
  });

  test('a refusal', async () => {
    const { actions } = fakeActions({ ok: false, refusal: 'Start date must be on or before the due date' });
    const root = view(actions);
    press(find(root, '[data-bar="p"] [data-handle="due"]'), 'ArrowLeft');
    await flush();
    assert({
      given: 'a change the server refuses',
      should: 'show why in a status row',
      actual: [...root.querySelectorAll('[role="status"]')].map((element) => element.textContent),
      expected: ['Start date must be on or before the due date'],
    });
  });

  test('scheduling from the tray', async () => {
    const { actions, calls } = fakeActions();
    const root = view(actions);
    click(find(root, '[aria-label="Schedule Book venue"]'));
    await flush();
    assert({
      given: 'Schedule on an unscheduled task',
      should: 'give it a due date a week from today',
      actual: calls,
      expected: [{ taskId: 'q', patch: { dueDate: at('2026-10-26') } }],
    });
  });

  test('the zoom is kept per list', () => {
    const root = view(fakeActions().actions);
    click(find(root, '[role="radio"]:nth-child(2)'));
    const bar = find(root, '[data-bar="p"]');
    unmountAll();
    const again = view(fakeActions().actions);
    assert({
      given: 'Months picked, then the Roadmap opened again',
      should: 'save the zoom under the list, draw days 12px wide, and open at it',
      actual: {
        saved: localStorage.getItem('imago:roadmap-zoom:l1'),
        width: bar.style.width,
        checked: find(again, '[role="radio"][aria-checked="true"]').textContent,
      },
      expected: { saved: 'months', width: '144px', checked: 'Months' },
    });
  });
});
