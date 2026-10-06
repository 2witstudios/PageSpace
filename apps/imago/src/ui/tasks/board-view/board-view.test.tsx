// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { click, mount, press, unmountAll } from '../../test-support/dom';
import { createInitialState } from '../../store/state';
import { setUiState } from '../../store/store';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { taskItem, taskListResponse } from '../task-model/fixtures';
import type { TaskItemResponse } from '../task-model/task';
import { TaskListView } from '../task-list-view/task-list-view';

// The Board as a viewer gets it: TaskListView over the real useTaskList and
// the imago API client, against a fake apps/web that answers the task routes.

const DRIVE = 'GET /api/drives/d1/pages?ls=true&recursive=true';
const L1 = 'GET /api/pages/l1/tasks?limit=200&offset=0';
const PAGE_P = 'GET /api/pages/page-p/tasks?limit=200&offset=0';
const PATCH_Z = 'PATCH /api/pages/l1/tasks/z';

/** l1 "Launch": parent p (one open subtask) in progress, leaf z to do. */
const served = (z: Partial<TaskItemResponse> = {}) =>
  Response.json(
    taskListResponse([
      taskItem('p', { title: 'Plan launch', status: 'in_progress', subTaskCount: 1, position: 0 }),
      taskItem('z', { title: 'Book venue', position: 1, ...z }),
    ]),
  );

const routes = (overrides: Record<string, FakeRoute> = {}): Record<string, FakeRoute> => ({
  [DRIVE]: () =>
    Response.json({
      mode: 'ls',
      pages: [{ id: 'l1', title: 'Launch', type: 'TASK_LIST', hasChildren: true, isTaskLinked: false }],
    }),
  [L1]: () => served(),
  [PAGE_P]: () => Response.json(taskListResponse([taskItem('a', { title: 'Draft copy' })])),
  ...overrides,
});

/** A promise and the function that settles it, for holding a route's answer. */
const gate = () => {
  let open: () => void = () => {};
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { shut, open: () => open() };
};

/** Answers the first request at once and holds every later one until released. */
const heldAfterFirst = (answer: () => Response) => {
  let calls = 0;
  const held = gate();
  const route: FakeRoute = async () => {
    calls += 1;
    if (calls > 1) await held.shut;
    return answer();
  };
  return { route, release: held.open, calls: () => calls };
};

beforeEach(() => {
  setUiState(createInitialState());
  localStorage.clear();
  // The viewer chose Board last time.
  localStorage.setItem('imago:task-view:u-1', 'board');
});

afterEach(unmountAll);

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

const open = async (table: Record<string, FakeRoute> = routes()) => {
  const web = fakeWeb(table);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <TaskListView driveId="d1" pageId="l1" viewerId="u-1" />
    </ImagoSWRProvider>,
  );
  await settle(() => {
    if (container.querySelector('[data-column]') === null) throw new Error('no board');
  });
  return { web, container };
};

/** Each column's name and the ids of the cards in it. */
const board = (container: HTMLElement) =>
  [...container.querySelectorAll('section[data-column]')].map((column) => [
    column.getAttribute('aria-label'),
    [...column.querySelectorAll('li[data-task]')].map((card) => card.getAttribute('data-task')),
  ]);

/** Each column header's read-out name and count. */
const counts = (container: HTMLElement) =>
  [...container.querySelectorAll('section[data-column] > h3')].map((heading) => heading.getAttribute('aria-label'));

const columnOf = (container: HTMLElement, id: string) =>
  container.querySelector(`li[data-task="${id}"]`)?.closest('section')?.getAttribute('aria-label');

const moveTrigger = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLButtonElement>(`button[data-move="${id}"]`) as HTMLButtonElement;

const announced = (container: HTMLElement) => container.querySelector('p[aria-live="polite"]')?.textContent;

/** Moves a card with Move to… from the keyboard alone: focus, Down to open, End, activate. */
const moveByKeyboard = (container: HTMLElement, id: string) => {
  const trigger = moveTrigger(container, id);
  act(() => trigger.focus());
  press(trigger, 'ArrowDown');
  const menu = container.querySelector('[role="menu"]') as HTMLElement;
  press(menu, 'End');
  // A focused button activates on Enter or Space natively; jsdom only clicks.
  click(document.activeElement as HTMLButtonElement);
};

/**
 * jsdom lays nothing out: place the columns side by side and each card in
 * its column, so the drag can measure them. Returns the undo.
 */
const layOut = (container: HTMLElement): (() => void) => {
  const columns = [...container.querySelectorAll('section[data-column]')];
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const column = this.closest('section[data-column]');
    const left = (column === null ? 0 : columns.indexOf(column)) * 252;
    const box =
      this === column ? { x: left, y: 100, width: 240, height: 400 } : { x: left + 20, y: 140, width: 200, height: 60 };
    return { ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box };
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
};

/** A key as the drag reads it: by `code`. */
const key = (target: EventTarget, code: string) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: code === 'Space' ? ' ' : code, code, bubbles: true, cancelable: true }),
    );
  });

/** What the drag's own live region last said. */
const spoken = () => document.querySelector('[id^="DndLiveRegion"]')?.textContent;

describe('Board view', () => {
  test('one column per status', async () => {
    const { container } = await open();
    assert({
      given: 'a list with PageSpace’s four statuses, opened on Board',
      should: 'draw a column per status in order, each holding its top-level tasks',
      actual: board(container),
      expected: [
        ['To Do', ['z']],
        ['In Progress', ['p']],
        ['Blocked', []],
        ['Done', []],
      ],
    });
    assert({
      given: 'the same board',
      should: 'show each column’s card count in its header',
      actual: counts(container),
      expected: ['To Do, 1 task', 'In Progress, 1 task', 'Blocked, 0 tasks', 'Done, 0 tasks'],
    });
    assert({
      given: 'the same board',
      should: 'link each card’s title to its task',
      actual: [...container.querySelectorAll('li[data-task] a[data-title]')].map((link) => link.getAttribute('href')),
      expected: ['/d1/tasks/page-z', '/d1/tasks/page-p'],
    });
  });

  test('Move to… from the keyboard', async () => {
    const answer = gate();
    let status = 'pending';
    const { web, container } = await open(
      routes({
        [L1]: () => served({ status }),
        [PATCH_Z]: async ({ body }) => {
          await answer.shut;
          status = (body as { status: string }).status;
          return Response.json(taskItem('z', { status }));
        },
      }),
    );
    moveByKeyboard(container, 'z');
    await settle(() => {
      if (web.writes().length === 0) throw new Error('not sent');
    });
    const whileSaving = { column: columnOf(container, 'z'), menu: container.querySelector('[role="menu"]') };
    const countsWhileSaving = counts(container);
    answer.open();
    await settle(() => {
      if (announced(container) === '') throw new Error('not announced');
    });
    assert({
      given: 'Book venue moved to Done with only the keyboard',
      should: 'PATCH its status with the CSRF token, show it in Done before the server answers, then announce it',
      actual: {
        writes: web.writes(),
        whileSaving,
        after: board(container),
        announced: announced(container),
        focus: document.activeElement === moveTrigger(container, 'z'),
      },
      expected: {
        writes: [{ method: 'PATCH', url: '/api/pages/l1/tasks/z', csrf: 'tok-1', body: { status: 'completed' } }],
        whileSaving: { column: 'Done', menu: null },
        after: [
          ['To Do', []],
          ['In Progress', ['p']],
          ['Blocked', []],
          ['Done', ['z']],
        ],
        announced: 'Moved Book venue to Done.',
        focus: true,
      },
    });
    assert({
      given: 'the same move',
      should: 'move one off To Do’s count and onto Done’s at once, and keep them once saved',
      actual: { countsWhileSaving, after: counts(container) },
      expected: {
        countsWhileSaving: ['To Do, 0 tasks', 'In Progress, 1 task', 'Blocked, 0 tasks', 'Done, 1 task'],
        after: ['To Do, 0 tasks', 'In Progress, 1 task', 'Blocked, 0 tasks', 'Done, 1 task'],
      },
    });
  });

  test('a move the server refuses rolls back', async () => {
    const list = heldAfterFirst(() => served());
    const { web, container } = await open(
      routes({
        [L1]: list.route,
        [PATCH_Z]: () => Response.json({ error: 'You do not have permission to edit this task' }, { status: 403 }),
      }),
    );
    moveByKeyboard(container, 'z');
    const whileSaving = columnOf(container, 'z');
    const countsWhileSaving = counts(container);
    // Refused, and the revalidating GET is held: only a rollback can have moved it back.
    await settle(() => {
      if (list.calls() < 2) throw new Error('not revalidating yet');
    });
    const beforeServerAnswers = columnOf(container, 'z');
    const countsBeforeServerAnswers = counts(container);
    list.release();
    await settle(() => {
      if (announced(container) === '') throw new Error('not announced');
    });
    assert({
      given: 'a move to Done the server refuses',
      should: 'show it in Done at once, send it, then put it back in To Do before the server answers again',
      actual: { whileSaving, writes: web.writes().length, beforeServerAnswers },
      expected: { whileSaving: 'Done', writes: 1, beforeServerAnswers: 'To Do' },
    });
    assert({
      given: 'the same refused move',
      should: 'count it in Done while saving, then count it back in To Do on the rollback',
      actual: { countsWhileSaving, countsBeforeServerAnswers },
      expected: {
        countsWhileSaving: ['To Do, 0 tasks', 'In Progress, 1 task', 'Blocked, 0 tasks', 'Done, 1 task'],
        countsBeforeServerAnswers: ['To Do, 1 task', 'In Progress, 1 task', 'Blocked, 0 tasks', 'Done, 0 tasks'],
      },
    });
    assert({
      given: 'the refusal',
      should: 'say why under the card and announce it',
      actual: {
        notice: container.querySelector('li[data-task="z"] > [role="status"]')?.textContent,
        announced: announced(container),
      },
      expected: {
        notice: 'You do not have permission to edit this task',
        announced: 'Could not move Book venue to Done: You do not have permission to edit this task',
      },
    });
  });

  test('a move PageSpace would refuse', async () => {
    const { web, container } = await open();
    moveByKeyboard(container, 'p');
    await settle(() => {
      if (announced(container) === '') throw new Error('not announced');
    });
    assert({
      given: 'a parent with an open subtask moved to Done',
      should: 'refuse it without a request, keep it in place and say why',
      actual: {
        writes: web.writes().length,
        column: columnOf(container, 'p'),
        notice: container.querySelector('li[data-task="p"] > [role="status"]')?.textContent,
      },
      expected: {
        writes: 0,
        column: 'In Progress',
        notice: 'Complete all sub-tasks first (1 of 1 remaining)',
      },
    });
  });

  test('dragging a card with the keyboard', async () => {
    let status = 'pending';
    const { web, container } = await open(
      routes({
        [L1]: () => served({ status }),
        [PATCH_Z]: ({ body }) => {
          status = (body as { status: string }).status;
          return Response.json(taskItem('z', { status }));
        },
      }),
    );
    const restore = layOut(container);
    try {
      const handle = container.querySelector<HTMLButtonElement>('button[data-drag="z"]') as HTMLButtonElement;
      act(() => handle.focus());
      const instructions = document.getElementById(handle.getAttribute('aria-describedby') ?? '')?.textContent;
      key(handle, 'Space');
      await settle(() => {
        if (spoken() === '') throw new Error('not picked up');
      });
      const heldOver = spoken();
      for (const _ of [1, 2, 3]) {
        key(document, 'ArrowRight');
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      const target = container.querySelector('section[data-column="completed"]')?.className.includes('border-dashed');
      const carried = spoken();
      key(document, 'Space');
      await settle(() => {
        if (announced(container) === '') throw new Error('not announced');
      });
      assert({
        given: 'Book venue picked up with Space, carried right three columns and dropped',
        should: 'tell the handle how, speak where it is held at each step, outline Done as it arrives, PATCH the card to Done and announce the move',
        actual: {
          instructions: instructions?.startsWith('To pick up a task, press Space or Enter.'),
          heldOver,
          carried,
          dropped: spoken(),
          target,
          writes: web.writes(),
          column: columnOf(container, 'z'),
          announced: announced(container),
        },
        expected: {
          instructions: true,
          heldOver: 'Book venue is over To Do.',
          carried: 'Book venue is over Done.',
          dropped: 'Book venue was dropped on Done.',
          target: true,
          writes: [{ method: 'PATCH', url: '/api/pages/l1/tasks/z', csrf: 'tok-1', body: { status: 'completed' } }],
          column: 'Done',
          announced: 'Moved Book venue to Done.',
        },
      });
    } finally {
      restore();
    }
  });

  test('cancelling a drag', async () => {
    const { web, container } = await open();
    const restore = layOut(container);
    try {
      const handle = container.querySelector<HTMLButtonElement>('button[data-drag="z"]') as HTMLButtonElement;
      act(() => handle.focus());
      key(handle, 'Space');
      await settle(() => {
        if (spoken() === '') throw new Error('not picked up');
      });
      key(document, 'ArrowRight');
      key(document, 'Escape');
      await settle(() => {
        if (!spoken()?.includes('cancelled')) throw new Error('not cancelled');
      });
      assert({
        given: 'a card picked up, carried a column and let go with Escape',
        should: 'say the move was cancelled, outline nothing and write nothing',
        actual: {
          spoken: spoken(),
          outlined: container.querySelectorAll('section.border-dashed').length,
          writes: web.writes().length,
          column: columnOf(container, 'z'),
        },
        expected: { spoken: 'Moving Book venue was cancelled.', outlined: 0, writes: 0, column: 'To Do' },
      });
    } finally {
      restore();
    }
  });

  test('a press outside the menu', async () => {
    const { container } = await open();
    act(() => moveTrigger(container, 'z').focus());
    press(moveTrigger(container, 'z'), 'ArrowDown');
    const opened = container.querySelector('[role="menu"]') !== null;
    const inside = container.querySelector('[role="menuitem"]') as HTMLElement;
    act(() => {
      inside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    const afterInside = container.querySelector('[role="menu"]') !== null;
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    assert({
      given: 'Move to… opened, then a press inside it, then one elsewhere',
      should: 'stay open for the press inside and close for the one outside',
      actual: { opened, afterInside, afterOutside: container.querySelector('[role="menu"]') !== null },
      expected: { opened: true, afterInside: true, afterOutside: false },
    });
  });
});
