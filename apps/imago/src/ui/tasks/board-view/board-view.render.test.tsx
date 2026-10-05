// @vitest-environment jsdom
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, press, unmountAll } from '../../test-support/dom';
import { seededStatuses, task } from '../task-model/fixtures';
import type { TaskStatus } from '../task-model/task';
import {
  renderBoard,
  renderBoardCard,
  renderBoardColumn,
  renderCardPreview,
  renderMoveMenu,
  type BoardCardRenderProps,
  type MoveMenuRenderProps,
} from './board-view.render';

afterEach(unmountAll);

const [todo, doing, blocked, done] = seededStatuses as [TaskStatus, TaskStatus, TaskStatus, TaskStatus];

const inertDrag = { ref: () => undefined, handle: {}, dragging: false };

const menu = (overrides: Partial<MoveMenuRenderProps> = {}): MoveMenuRenderProps => ({
  title: 'Book venue',
  taskId: 'z',
  targets: [doing, blocked, done],
  open: false,
  setOpen: () => undefined,
  choose: () => undefined,
  ...overrides,
});

const card = (overrides: Partial<BoardCardRenderProps> = {}): BoardCardRenderProps => ({
  task: task('z', { title: 'Book venue' }),
  done: false,
  drag: inertDrag,
  move: menu(),
  notice: null,
  ...overrides,
});

describe('renderBoardColumn()', () => {
  test('a column', () => {
    const container = mount(
      renderBoardColumn({ status: doing, count: 2, target: false, dropRef: () => undefined, cards: null }),
    );
    const column = container.querySelector('section');
    assert({
      given: 'the In Progress status holding two tasks, with no limit',
      should: 'name the column by its status, count its tasks and show no limit',
      actual: {
        name: column?.getAttribute('aria-label'),
        column: column?.getAttribute('data-column'),
        heading: column?.querySelector('h3')?.textContent,
        cards: column?.querySelector('ul')?.getAttribute('aria-label'),
        wip: container.querySelector('[data-wip]'),
      },
      expected: {
        name: 'In Progress',
        column: 'in_progress',
        heading: 'In Progress2',
        cards: 'In Progress tasks',
        wip: null,
      },
    });
  });

  test('WIP limits', () => {
    const limited = { ...doing, wipLimit: 2 };
    const within = mount(renderBoardColumn({ status: limited, count: 2, target: false, dropRef: () => undefined, cards: null }));
    const over = mount(renderBoardColumn({ status: limited, count: 3, target: false, dropRef: () => undefined, cards: null }));
    const badge = (container: HTMLElement) => container.querySelector('[data-wip]');
    assert({
      given: 'a column limited to two holding two, then three',
      should: 'show its count against the limit, in the live tone once over it',
      actual: [within, over].map((container) => ({
        text: badge(container)?.textContent,
        label: badge(container)?.getAttribute('aria-label'),
        over: badge(container)?.className.includes('text-live'),
      })),
      expected: [
        { text: 'WIP 2/2', label: 'Work in progress: 2 of 2', over: false },
        { text: 'WIP 3/2', label: 'Work in progress: 3 of 2, over the limit', over: true },
      ],
    });
  });

  test('an empty column and a drop target', () => {
    const container = mount(
      renderBoardColumn({ status: todo, count: 0, target: true, dropRef: () => undefined, cards: null }),
    );
    assert({
      given: 'an empty column a card is dragged over',
      should: 'say it has no tasks and outline it as the target',
      actual: [
        container.querySelector('section p')?.textContent,
        container.querySelector('section')?.className.includes('border-dashed'),
      ],
      expected: ['No tasks', true],
    });
  });
});

describe('renderBoardCard()', () => {
  test('a card', () => {
    const container = mount(
      renderBoardCard(
        card({
          task: task('p', { title: 'Plan launch', subTaskCount: 2, subTaskCompletedCount: 1 }),
          move: menu({ title: 'Plan launch', taskId: 'p' }),
        }),
      ),
    );
    assert({
      given: 'a parent task with one of two subtasks done',
      should: 'show its title, its subtask progress, a drag handle and Move to…',
      actual: {
        task: container.querySelector('li')?.getAttribute('data-task'),
        title: container.querySelector('[data-title]')?.textContent,
        progress: container.querySelector('[role="progressbar"]')?.getAttribute('aria-label'),
        handle: container.querySelector('button[data-drag]')?.getAttribute('aria-label'),
        move: container.querySelector('button[aria-haspopup="menu"]')?.getAttribute('aria-label'),
      },
      expected: {
        task: 'p',
        title: 'Plan launch',
        progress: '1 of 2 subtasks done',
        handle: 'Drag Plan launch',
        move: 'Move Plan launch to…',
      },
    });
  });

  test('done, dragged and refused', () => {
    const container = mount(
      renderBoardCard(
        card({ done: true, drag: { ...inertDrag, dragging: true }, notice: 'Complete all sub-tasks first' }),
      ),
    );
    assert({
      given: 'a done card in flight whose last move was refused',
      should: 'strike its title, fade it and say why under it',
      actual: [
        container.querySelector('[data-title]')?.className.includes('line-through'),
        container.querySelector('article')?.className.includes('opacity-60'),
        container.querySelector('li > [role="status"]')?.textContent,
      ],
      expected: [true, true, 'Complete all sub-tasks first'],
    });
  });
});

describe('renderMoveMenu()', () => {
  const items = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];

  test('closed', () => {
    const opened: boolean[] = [];
    const container = mount(renderMoveMenu(menu({ setOpen: (open) => opened.push(open) })));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    if (trigger) click(trigger);
    if (trigger) press(trigger, 'ArrowDown');
    assert({
      given: 'a closed Move to… clicked, then pressed Down',
      should: 'show no menu, say it is collapsed, and ask to open each time',
      actual: { menu: container.querySelector('[role="menu"]'), expanded: trigger?.getAttribute('aria-expanded'), opened },
      expected: { menu: null, expanded: 'false', opened: [true, true] },
    });
  });

  test('open', () => {
    const container = mount(renderMoveMenu(menu({ open: true })));
    const trigger = container.querySelector('button[aria-haspopup="menu"]');
    const list = container.querySelector('[role="menu"]');
    assert({
      given: 'an open Move to… for a task in To Do',
      should: 'list every other status, focus the first and tie the menu to its trigger',
      actual: {
        expanded: trigger?.getAttribute('aria-expanded'),
        controls: trigger?.getAttribute('aria-controls') === list?.id,
        label: list?.getAttribute('aria-label'),
        items: items(container).map((item) => item.textContent),
        focused: document.activeElement?.textContent,
      },
      expected: {
        expanded: 'true',
        controls: true,
        label: 'Move Book venue to',
        items: ['In Progress', 'Blocked', 'Done'],
        focused: 'In Progress',
      },
    });
  });

  test('the keyboard', () => {
    const chosen: string[] = [];
    const opened: boolean[] = [];
    const container = mount(
      renderMoveMenu(menu({ open: true, choose: (status) => chosen.push(status.slug), setOpen: (open) => opened.push(open) })),
    );
    const list = container.querySelector('[role="menu"]') as HTMLElement;
    const focused = () => document.activeElement?.textContent ?? undefined;
    const walk: (string | null | undefined)[] = [];
    press(list, 'ArrowDown');
    walk.push(focused());
    press(list, 'ArrowDown');
    walk.push(focused());
    press(list, 'ArrowDown');
    walk.push(focused());
    press(list, 'ArrowUp');
    walk.push(focused());
    press(list, 'End');
    walk.push(focused());
    press(list, 'Home');
    walk.push(focused());
    click(document.activeElement as HTMLButtonElement);
    press(list, 'Escape');
    assert({
      given: 'Down three times, Up, End, Home, then choosing, then Escape',
      should: 'move focus through the items, wrapping, choose the focused one and ask to close',
      actual: { walk, chosen, opened },
      expected: {
        walk: ['Blocked', 'Done', 'In Progress', 'Done', 'Done', 'In Progress'],
        chosen: ['in_progress'],
        opened: [false],
      },
    });
  });
});

describe('renderBoard()', () => {
  test('the board', () => {
    const container = mount(renderBoard({ label: 'Launch board', columns: <section />, announcement: 'Moved Book venue to Done.' }));
    const live = container.querySelector('[aria-live="polite"]');
    assert({
      given: 'columns and the last move',
      should: 'group the columns under the list’s name and announce the move politely',
      actual: [container.querySelector('[role="group"]')?.getAttribute('aria-label'), live?.textContent, live?.getAttribute('role')],
      expected: ['Launch board', 'Moved Book venue to Done.', 'status'],
    });
  });
});

describe('renderCardPreview()', () => {
  test('the card in flight', () => {
    const container = mount(renderCardPreview('Book venue'));
    assert({
      given: 'a card being dragged',
      should: 'draw its title on a card, hidden from assistive tech (the live region speaks for the drag)',
      actual: [container.textContent, container.firstElementChild?.getAttribute('aria-hidden')],
      expected: ['Book venue', 'true'],
    });
  });
});
