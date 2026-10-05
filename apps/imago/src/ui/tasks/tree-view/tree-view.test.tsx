// @vitest-environment jsdom
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, press, typeInto, unmountAll } from '../../test-support/dom';
import { list as taskList, task } from '../task-model/fixtures';
import type { TaskList } from '../task-model/task';
import { renderTreeView, type TreeViewRenderProps } from './tree-view.render';

afterEach(unmountAll);

/** l1: parent p (subtask a open, a's own subtask a1 done) and done leaf z. */
const tree = (): TaskList =>
  taskList('l1', [
    task('p', {
      title: 'Plan launch',
      subTaskCount: 1,
      subtasks: taskList('page-p', [
        task('a', {
          title: 'Draft copy',
          subTaskCount: 1,
          subTaskCompletedCount: 1,
          subtasks: taskList('page-a', [task('a1', { title: 'Outline', status: 'completed' })]),
        }),
      ]),
    }),
    task('z', { title: 'Book venue', status: 'completed' }),
  ], { title: 'Launch' });

type Calls = { toggled: string[]; completed: string[]; added: [string, string, string][] };

const setup = (overrides: Partial<TreeViewRenderProps> = {}) => {
  const calls: Calls = { toggled: [], completed: [], added: [] };
  const props: TreeViewRenderProps = {
    list: tree(),
    expandedIds: [],
    notice: null,
    toggleExpanded: (id) => calls.toggled.push(id),
    toggleComplete: (id) => calls.completed.push(id),
    addTask: (listPageId, at, title) => calls.added.push([listPageId, at, title]),
    ...overrides,
  };
  const container = mount(renderTreeView(props));
  return { container, calls };
};

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll('li[data-task]')].map((row) => row.getAttribute('data-task'));

const checkbox = (container: HTMLElement, title: string) => {
  const box = container.querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label="Complete ${title}"]`);
  if (!box) throw new Error(`no checkbox for ${title}`);
  return box;
};

describe('renderTreeView()', () => {
  test('collapsed', () => {
    const { container } = setup();
    const list = container.querySelector('ul');
    assert({
      given: 'a list with nothing expanded',
      should: 'show its top-level tasks as a named list, each ticked by its own list’s done group',
      actual: {
        name: list?.getAttribute('aria-label'),
        rows: rows(container),
        ticked: [checkbox(container, 'Plan launch'), checkbox(container, 'Book venue')].map((box) =>
          box.getAttribute('aria-checked'),
        ),
      },
      expected: { name: 'Launch tasks', rows: ['p', 'z'], ticked: ['false', 'true'] },
    });
  });

  test('carets and progress', () => {
    const { container } = setup();
    const caret = container.querySelector('[aria-label="Toggle Plan launch"]');
    assert({
      given: 'a parent with subtasks and a leaf',
      should: 'give only the parent a collapsed caret and a meter of its direct subtasks',
      actual: {
        expanded: caret?.getAttribute('aria-expanded'),
        leafCaret: container.querySelector('[aria-label="Toggle Book venue"]'),
        meters: [...container.querySelectorAll('[role="progressbar"]')].map((bar) => bar.getAttribute('aria-label')),
      },
      expected: { expanded: 'false', leafCaret: null, meters: ['0 of 1 subtasks done'] },
    });
  });

  test('done tasks read as done', () => {
    const { container } = setup();
    const title = (id: string) => container.querySelector(`li[data-task="${id}"] [data-title]`)?.className ?? '';
    assert({
      given: 'an open task and a done one',
      should: 'strike through only the done title',
      actual: [title('p').includes('line-through'), title('z').includes('line-through')],
      expected: [false, true],
    });
  });

  test('expanded, nested', () => {
    const { container } = setup({ expandedIds: ['p', 'a'] });
    const nested = container.querySelector('ul[aria-label="Plan launch"]');
    assert({
      given: 'a parent and its subtask expanded',
      should: 'nest each level in its own named list, ticked by that level’s list',
      actual: {
        rows: rows(container),
        nested: nested === null ? [] : [...nested.children].flatMap((row) => row.getAttribute('data-task') ?? []),
        expanded: container.querySelector('[aria-label="Toggle Plan launch"]')?.getAttribute('aria-expanded'),
        outline: checkbox(container, 'Outline').getAttribute('aria-checked'),
      },
      expected: { rows: ['p', 'a', 'a1', 'z'], nested: ['a'], expanded: 'true', outline: 'true' },
    });
  });

  test('toggling', () => {
    const { container, calls } = setup();
    const caret = container.querySelector<HTMLButtonElement>('[aria-label="Toggle Plan launch"]');
    if (caret) click(caret);
    click(checkbox(container, 'Book venue'));
    click(checkbox(container, 'Plan launch'));
    assert({
      given: 'a caret clicked, then two checkboxes',
      should: 'ask to expand that task and to toggle each task by id',
      actual: calls,
      expected: { toggled: ['p'], completed: ['z', 'p'], added: [] },
    });
  });

  test('inline add at every open level', () => {
    const { container, calls } = setup({ expandedIds: ['p'] });
    const adders = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => button.textContent === 'Add task' || button.textContent === 'Add subtask',
    );
    const names = adders.map((button) => button.textContent);
    const [addSubtask, addTask] = adders;
    if (addSubtask) click(addSubtask);
    const sub = container.querySelector<HTMLInputElement>('input[aria-label="Add subtask"]');
    if (sub) {
      typeInto(sub, 'Proofread');
      press(sub, 'Enter');
    }
    if (addTask) click(addTask);
    const top = container.querySelector<HTMLInputElement>('input[aria-label="Add task"]');
    if (top) {
      typeInto(top, 'Send invites');
      press(top, 'Enter');
    }
    assert({
      given: 'p expanded, then a subtask and a top-level task added',
      should: 'add the subtask to p’s own page and the task to the list’s page',
      actual: { names, added: calls.added },
      expected: {
        names: ['Add subtask', 'Add task'],
        added: [
          ['page-p', 'p', 'Proofread'],
          ['l1', 'l1', 'Send invites'],
        ],
      },
    });
  });

  test('five levels deep', () => {
    // Level 5 holds a sixth-level task, as a tree from elsewhere might, so a
    // level-5 "Add subtask" would render if the depth guard were missing.
    const deep = (level: number): TaskList =>
      taskList(`page-${level - 1}`, [
        task(`t${level}`, level < 6 ? { subTaskCount: 1, subtasks: deep(level + 1) } : {}),
      ]);
    const list = { ...deep(1), pageId: 'l1' };
    const { container } = setup({ list, expandedIds: ['t1', 't2', 't3', 't4', 't5'] });
    const adders = [...container.querySelectorAll('li[data-task]')]
      .filter((row) =>
        [...(row.querySelector(':scope > ul')?.children ?? [])].some(
          (child) => child.querySelector(':scope > button')?.textContent === 'Add subtask',
        ),
      )
      .map((row) => row.getAttribute('data-task'));
    assert({
      given: 'a chain six levels deep, all expanded',
      should: 'offer Add subtask under levels one to four and refuse it under level five (PageSpace nests five deep)',
      actual: { rows: rows(container), adders },
      expected: { rows: ['t1', 't2', 't3', 't4', 't5', 't6'], adders: ['t1', 't2', 't3', 't4'] },
    });
  });

  test('a refusal', () => {
    const { container } = setup({
      expandedIds: ['p'],
      notice: { at: 'p', message: 'Complete all sub-tasks first (1 of 1 remaining)' },
    });
    const status = [...(container.querySelector('li[data-task="p"]')?.children ?? [])].find(
      (child) => child.getAttribute('role') === 'status',
    );
    assert({
      given: 'a completion refused for p',
      should: 'say why under p’s own row',
      actual: [status?.textContent, container.querySelectorAll('[role="status"]').length],
      expected: ['Complete all sub-tasks first (1 of 1 remaining)', 1],
    });
  });

  test('a refused add to the list', () => {
    const { container } = setup({ notice: { at: 'l1', message: 'Title is required' } });
    assert({
      given: 'an add to the list refused',
      should: 'say why beside the list’s own Add task',
      actual: container.querySelector('ul[aria-label="Launch tasks"] > li > [role="status"]')?.textContent,
      expected: 'Title is required',
    });
  });

  test('an empty list', () => {
    const { container } = setup({ list: taskList('l1', []) });
    assert({
      given: 'a list with no tasks',
      should: 'still offer Add task',
      actual: [rows(container), container.querySelector('button')?.textContent],
      expected: [[], 'Add task'],
    });
  });

  test('rows that open their task', () => {
    const { container } = setup({ expandedIds: ['p'], taskHref: (entry) => `/d1/tasks/${entry.pageId}` });
    const titles = [...container.querySelectorAll('[data-title]')];
    assert({
      given: 'a way to address each task',
      should: 'make every title a link to its task, and keep the other controls as they were',
      actual: {
        links: titles.map((title) => [title.tagName, title.getAttribute('href')]),
        checkboxes: container.querySelectorAll('[role="checkbox"]').length,
      },
      expected: {
        links: [
          ['A', '/d1/tasks/page-p'],
          ['A', '/d1/tasks/page-a'],
          ['A', '/d1/tasks/page-z'],
        ],
        checkboxes: 3,
      },
    });
  });

  test('an outline under a task', () => {
    const { container, calls } = setup({
      list: taskList('page-p', [task('a', { title: 'Draft copy', subTaskCount: 1, subtasks: taskList('page-a', [task('a1')]) })], {
        title: 'Plan launch',
      }),
      expandedIds: ['a'],
      level: 3,
      addLabel: 'Add subtask',
      addPlaceholder: 'Subtask title',
    });
    const adders = [...container.querySelectorAll('button')].filter((button) => button.textContent === 'Add subtask');
    click(adders[0] as HTMLButtonElement);
    const input = container.querySelector<HTMLInputElement>('input[placeholder="Subtask title"]');
    typeInto(input as HTMLInputElement, 'Edit');
    press(input as HTMLInputElement, 'Enter');
    assert({
      given: 'the subtasks of a task on level 3, with a at level 4 expanded',
      should: 'nest only as deep as PageSpace allows below them, and add to the task’s own list',
      actual: { rows: rows(container), adders: adders.length, added: calls.added },
      expected: { rows: ['a', 'a1'], adders: 2, added: [['page-a', 'a', 'Edit']] },
    });
  });

  test('an outline at the deepest level', () => {
    const { container } = setup({ list: taskList('page-5', []), level: 5, addLabel: 'Add subtask' });
    assert({
      given: 'the subtasks of a task on the fifth level',
      should: 'offer no add, since nothing nests deeper',
      actual: container.querySelectorAll('button').length,
      expected: 0,
    });
  });
});
