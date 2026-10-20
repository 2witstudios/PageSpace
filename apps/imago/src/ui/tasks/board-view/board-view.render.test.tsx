// @vitest-environment jsdom
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, press, typeInto, unmountAll } from '../../test-support/dom';
import { dueDateFor } from '../task-detail/due-date';
import { seededStatuses, task } from '../task-model/fixtures';
import type { TaskStatus } from '../task-model/task';
import {
  renderBoard,
  renderBoardCard,
  renderBoardColumn,
  renderCardMenu,
  renderCardPreview,
  renderColumnMenu,
  renderColumnRail,
  renderMoveMenu,
  type BoardCardRenderProps,
  type BoardCellRenderProps,
  type CardMenuRenderProps,
  type ColumnMenuRenderProps,
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
  today: '2026-10-05',
  drag: inertDrag,
  move: menu(),
  menu: null,
  subtasks: null,
  insert: null,
  adding: null,
  notice: null,
  ...overrides,
});

const columnMenu = (overrides: Partial<ColumnMenuRenderProps> = {}): ColumnMenuRenderProps => ({
  status: todo,
  open: false,
  setOpen: () => undefined,
  wip: null,
  collapse: () => undefined,
  ...overrides,
});

type ColumnOverrides = Partial<BoardCellRenderProps> & { readonly add?: (title: string) => void };

/** A column with its head, as the board without lanes draws it. */
const columnProps = ({ add = () => undefined, ...overrides }: ColumnOverrides = {}): BoardCellRenderProps => {
  const status = overrides.status ?? todo;
  const count = overrides.count ?? 0;
  return {
    status,
    head: { status, count, add: () => undefined, menu: columnMenu({ status }) },
    label: status.name,
    count,
    target: false,
    dropRef: () => undefined,
    cards: null,
    insertAtEnd: false,
    newCard: { cell: `all::${status.slug}`, add },
    notice: null,
    ...overrides,
  };
};

describe('renderBoardColumn()', () => {
  test('a column', () => {
    const container = mount(
      renderBoardColumn(columnProps({ status: doing, count: 2 })),
    );
    const column = container.querySelector('section');
    const heading = column?.querySelector('h3');
    assert({
      given: 'the In Progress status holding two tasks',
      should: 'name the column by its status and show its card count, read out with the name',
      actual: {
        name: column?.getAttribute('aria-label'),
        column: column?.getAttribute('data-column'),
        heading: heading?.textContent,
        label: heading?.getAttribute('aria-label'),
        count: heading?.querySelector('[data-count]')?.textContent,
        cards: column?.querySelector('ul')?.getAttribute('aria-label'),
      },
      expected: {
        name: 'In Progress',
        column: 'in_progress',
        heading: 'In Progress2',
        label: 'In Progress, 2 tasks',
        count: '2',
        cards: 'In Progress tasks',
      },
    });
  });

  test('the count read out', () => {
    const label = (count: number) =>
      mount(renderBoardColumn(columnProps({ count })))
        .querySelector('h3')
        ?.getAttribute('aria-label');
    assert({
      given: 'a column holding none, one and three tasks',
      should: 'read out its name and count, singular for one',
      actual: [0, 1, 3].map(label),
      expected: ['To Do, 0 tasks', 'To Do, 1 task', 'To Do, 3 tasks'],
    });
  });

  test('an empty column and a drop target', () => {
    const container = mount(
      renderBoardColumn(columnProps({ target: true })),
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

describe('a column’s New card', () => {
  test('adding a card', () => {
    const added: string[] = [];
    const container = mount(renderBoardColumn(columnProps({ status: blocked, add: (title) => added.push(title) })));
    const rest = [...container.querySelectorAll('button')].find((button) => button.textContent === 'New card');
    const inColumn = rest?.closest('section')?.getAttribute('aria-label');
    if (rest) click(rest);
    const field = container.querySelector<HTMLInputElement>('input[aria-label="New card"]') as HTMLInputElement;
    typeInto(field, '  Chase supplier  ');
    press(field, 'Enter');
    assert({
      given: 'New card in the Blocked column, opened, typed into and committed with Enter',
      should: 'offer the add under the cards and hand the trimmed title to the column',
      actual: { rest: inColumn, placeholder: field.placeholder, added },
      expected: { rest: 'Blocked', placeholder: 'Card title', added: ['Chase supplier'] },
    });
  });

  test('a refused card', () => {
    const container = mount(renderBoardColumn(columnProps({ notice: 'Title is required' })));
    assert({
      given: 'a column whose last New card was refused',
      should: 'say why in the column',
      actual: container.querySelector('section [role="status"]')?.textContent,
      expected: 'Title is required',
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
        move: container.querySelector('button[data-move]')?.getAttribute('aria-label'),
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

  test('a card that opens its task', () => {
    const container = mount(renderBoardCard(card({ href: '/d1/tasks/page-z' })));
    const title = container.querySelector('[data-title]');
    assert({
      given: 'a card with a link to its task',
      should: 'make its title the link to the task’s detail',
      actual: [title?.tagName, title?.getAttribute('href'), title?.textContent],
      expected: ['A', '/d1/tasks/page-z', 'Book venue'],
    });
  });

  test('what needs attention', () => {
    const container = mount(
      renderBoardCard(
        card({
          task: task('z', {
            title: 'Book venue',
            status: 'blocked',
            priority: 'high',
            dueDate: dueDateFor('2026-10-07'),
            assignees: [
              { type: 'user', id: 'u-1', name: 'Ada Lovelace' },
              { type: 'agent', id: 'ag-1', name: 'Imago' },
            ],
          }),
        }),
      ),
    );
    const due = container.querySelector('time');
    assert({
      given: 'a blocked, high-priority card due 7 October with a person and an agent on it',
      should: 'flag it Blocked and High priority, show its due day and everyone on it',
      actual: {
        blocked: container.querySelector('[data-blocked]')?.textContent,
        priority: container.querySelector('[data-priority]')?.textContent,
        priorityTone: container.querySelector('[data-priority]')?.className.includes('text-live'),
        due: [due?.textContent, due?.getAttribute('dateTime'), due?.getAttribute('data-tone')],
        assignees: container.querySelector('[role="img"]')?.getAttribute('aria-label'),
      },
      expected: {
        blocked: 'Blocked',
        priority: 'High priority',
        priorityTone: true,
        due: ['Oct 7', '2026-10-07', 'soon'],
        assignees: 'Assigned to Ada Lovelace, Imago',
      },
    });
  });

  test('a quiet card', () => {
    const container = mount(renderBoardCard(card({ task: task('z', { title: 'Book venue', priority: 'medium' }) })));
    assert({
      given: 'a medium-priority card with no due date and no one on it',
      should: 'show no flags, no date and no faces',
      actual: [
        container.querySelector('[data-blocked]'),
        container.querySelector('[data-priority]'),
        container.querySelector('time'),
        container.querySelector('[role="img"]'),
      ],
      expected: [null, null, null, null],
    });
  });

  test('a low priority, overdue card', () => {
    const container = mount(
      renderBoardCard(card({ task: task('z', { priority: 'low', dueDate: dueDateFor('2026-10-04') }) })),
    );
    assert({
      given: 'a low-priority open card due yesterday',
      should: 'flag Low priority quietly and read the date as overdue',
      actual: [
        container.querySelector('[data-priority]')?.textContent,
        container.querySelector('[data-priority]')?.className.includes('text-ink-faint'),
        container.querySelector('time')?.textContent,
        container.querySelector('time')?.getAttribute('data-tone'),
      ],
      expected: ['Low priority', true, 'Yesterday', 'overdue'],
    });
  });

  test('a card with subtasks, closed and open', () => {
    const toggled: number[] = [];
    const closed = mount(
      renderBoardCard(
        card({ subtasks: { open: false, toggle: () => toggled.push(1), list: <ul aria-label="Book venue subtasks" /> } }),
      ),
    );
    const caret = closed.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (caret) click(caret);
    const opened = mount(
      renderBoardCard(card({ subtasks: { open: true, toggle: () => undefined, list: <ul aria-label="Book venue subtasks" /> } })),
    );
    assert({
      given: 'a card with subtasks, closed then open',
      should: 'offer a caret that toggles, and show the subtasks in the card only while open',
      actual: {
        caret: [caret?.getAttribute('aria-label'), caret?.getAttribute('aria-expanded')],
        toggled: toggled.length,
        closedList: closed.querySelector('ul[aria-label="Book venue subtasks"]'),
        open: opened.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'),
        inCard: opened.querySelector('article ul[aria-label="Book venue subtasks"]') !== null,
      },
      expected: {
        caret: ['Toggle Book venue', 'false'],
        toggled: 1,
        closedList: null,
        open: 'true',
        inCard: true,
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
      should: 'strike its title, leave a dashed slot and say why under it',
      actual: [
        container.querySelector('[data-title]')?.className.includes('line-through'),
        container.querySelector('article')?.className.includes('border-dashed'),
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
    const container = mount(
      renderBoard({ label: 'Launch board', body: <section />, announcement: 'Moved Book venue to Done.', lanes: 'none', selectLanes: () => undefined }),
    );
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

describe('a column’s head', () => {
  test('a WIP limit', () => {
    const chip = (count: number) => {
      const container = mount(renderBoardColumn(columnProps({ status: { ...doing, wipLimit: 2 }, count })));
      const count$ = container.querySelector('[data-count]');
      return [count$?.textContent, count$?.getAttribute('data-wip'), container.querySelector('h3')?.getAttribute('aria-label')];
    };
    assert({
      given: 'In Progress limited to two, holding one, two and three',
      should: 'show the count against the limit, warning at it and reading over it',
      actual: [chip(1), chip(2), chip(3)],
      expected: [
        ['1/2', 'under', 'In Progress, 1 task, limit 2'],
        ['2/2', 'at', 'In Progress, 2 tasks, limit 2'],
        ['3/2', 'over', 'In Progress, 3 tasks, limit 2, over the limit'],
      ],
    });
  });

  test('"+" and a read-only column', () => {
    const pressed: number[] = [];
    const editable = mount(
      renderBoardColumn(columnProps({ head: { status: todo, count: 0, add: () => pressed.push(1), menu: columnMenu() } })),
    );
    click(editable.querySelector('button[aria-label="New card in To Do"]') as HTMLButtonElement);
    const readOnly = mount(
      renderBoardColumn(columnProps({ head: { status: todo, count: 0, add: null, menu: columnMenu() }, newCard: null })),
    );
    assert({
      given: 'a column’s "+" pressed, and a column for a viewer who may only read',
      should: 'ask to open New card, and draw neither "+" nor New card read-only',
      actual: {
        pressed,
        plus: readOnly.querySelector('button[aria-label="New card in To Do"]'),
        newCard: readOnly.querySelector('[data-new-card]'),
      },
      expected: { pressed: [1], plus: null, newCard: null },
    });
  });

  test('the column menu', () => {
    const calls: string[] = [];
    const container = mount(
      renderColumnMenu(
        columnMenu({
          open: true,
          collapse: () => calls.push('collapse'),
          wip: { editing: true, draft: '4', start: () => calls.push('start'), type: (draft) => calls.push(`type ${draft}`), save: () => calls.push('save') },
        }),
      ),
    );
    const field = container.querySelector<HTMLInputElement>('input') as HTMLInputElement;
    const focused = document.activeElement === field;
    typeInto(field, '5');
    press(field, 'Enter');
    click([...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === 'Collapse') as HTMLButtonElement);
    assert({
      given: 'the column menu open on its limit field, 5 typed, Enter, then Collapse',
      should: 'focus the field on the draft, hand on the typing, save on Enter and collapse',
      actual: { label: field.getAttribute('aria-label'), value: field.value, focused, calls },
      expected: { label: 'WIP limit for To Do', value: '4', focused: true, calls: ['type 5', 'save', 'collapse'] },
    });
  });
});

describe('renderColumnRail()', () => {
  test('a folded column', () => {
    const expanded: number[] = [];
    const container = mount(
      renderColumnRail({ status: done, label: 'Done', count: 3, target: false, dropRef: () => undefined, expand: () => expanded.push(1), named: true }),
    );
    const button = container.querySelector<HTMLButtonElement>('button[data-expand]') as HTMLButtonElement;
    click(button);
    assert({
      given: 'Done folded to a rail holding three, then pressed',
      should: 'keep it a column to drop on, name it with its count, and ask to open it',
      actual: {
        column: container.querySelector('section')?.getAttribute('data-column'),
        label: button.getAttribute('aria-label'),
        text: button.textContent,
        expanded,
      },
      expected: { column: 'completed', label: 'Expand Done, 3 tasks', text: '3Done', expanded: [1] },
    });
  });
});

describe('renderCardMenu()', () => {
  const cardMenu = (overrides: Partial<CardMenuRenderProps> = {}): CardMenuRenderProps => ({
    title: 'Book venue',
    taskId: 'z',
    href: '/d1/tasks/page-z',
    open: true,
    setOpen: () => undefined,
    confirming: false,
    setConfirming: () => undefined,
    addSubtask: () => undefined,
    remove: () => undefined,
    ...overrides,
  });
  const items = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];

  test('open, then asking first', () => {
    const calls: string[] = [];
    const open = mount(renderCardMenu(cardMenu({ setConfirming: (on) => calls.push(`confirm ${on}`), addSubtask: () => calls.push('add') })));
    const offered = items(open).map((item) => [item.textContent, item.getAttribute('href')]);
    click(items(open)[1] as HTMLElement);
    click(items(open)[2] as HTMLElement);
    const asking = mount(renderCardMenu(cardMenu({ confirming: true, remove: () => calls.push('remove'), setConfirming: (on) => calls.push(`confirm ${on}`) })));
    const question = asking.querySelector('p')?.textContent;
    click(items(asking)[1] as HTMLElement);
    click(items(asking)[0] as HTMLElement);
    assert({
      given: 'a card’s ⋯ menu: Add subtask, Delete…, then No and Yes on the question',
      should: 'link Open to the task, and only delete once Yes is chosen in the menu',
      actual: { offered, question, calls },
      expected: {
        offered: [
          ['Open', '/d1/tasks/page-z'],
          ['Add subtask', null],
          ['Delete…', null],
        ],
        question: 'Delete Book venue?',
        calls: ['add', 'confirm true', 'confirm false', 'remove'],
      },
    });
  });
});

describe('where a card will land', () => {
  test('lines before, after and at the end', () => {
    const before = mount(renderBoardCard(card({ insert: 'before' })));
    const after = mount(renderBoardCard(card({ insert: 'after' })));
    const end = mount(renderBoardColumn(columnProps({ insertAtEnd: true })));
    const place = (container: HTMLElement) => {
      const line = container.querySelector('[data-insert]');
      return line === null ? null : line.nextElementSibling?.tagName ?? 'last';
    };
    assert({
      given: 'a card dragged in from another cell, held before a card, after it, and over an empty cell',
      should: 'draw the landing line on that side, and at the end of the cell without saying it has no tasks',
      actual: [place(before), place(after), end.querySelector('[data-insert]') !== null, end.querySelector('section > p')?.textContent],
      expected: ['ARTICLE', 'last', true, undefined],
    });
  });
});
