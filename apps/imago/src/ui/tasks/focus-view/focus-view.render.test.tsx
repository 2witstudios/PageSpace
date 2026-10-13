// @vitest-environment jsdom
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, press, typeInto, unmountAll } from '../../test-support/dom';
import { list, parent, task } from '../task-model/fixtures';
import type { TaskList } from '../task-model/task';
import { doneToday, frontier } from './focus';
import { renderFocusView, type FocusViewRenderProps } from './focus-view.render';

afterEach(unmountAll);

const today = new Date(2026, 9, 5, 12);

/** l1 "Launch": parent p (open a, b done today) and loose open leaf z. */
const launch = (): TaskList =>
  list(
    'l1',
    [
      parent(
        'p',
        [
          task('a', { title: 'Draft copy' }),
          task('b', { title: 'Pick date', status: 'completed', completedAt: new Date(2026, 9, 5, 9).toISOString() }),
        ],
        { title: 'Plan launch' },
      ),
      task('z', { title: 'Book venue' }),
    ],
    { title: 'Launch' },
  );

type Calls = { completed: string[]; captured: string[] };

const setup = (root: TaskList = launch(), overrides: Partial<FocusViewRenderProps> = {}) => {
  const calls: Calls = { completed: [], captured: [] };
  const props: FocusViewRenderProps = {
    title: root.title,
    listPageId: root.pageId,
    groups: frontier(root),
    done: doneToday(root, today),
    notice: null,
    toggleComplete: (id) => calls.completed.push(id),
    capture: (title) => calls.captured.push(title),
    ...overrides,
  };
  return { container: mount(renderFocusView(props)), calls };
};

const sectionRows = (container: HTMLElement) =>
  [...container.querySelectorAll('section')].map((section) => ({
    group: section.getAttribute('aria-label'),
    heading: section.querySelector('h3')?.textContent,
    rows: [...section.querySelectorAll('li[data-task]')].map((row) => ({
      id: row.getAttribute('data-task'),
      checked: row.querySelector('[role="checkbox"]')?.getAttribute('aria-checked'),
    })),
  }));

describe('renderFocusView()', () => {
  test('open leaves by parent, then done today', () => {
    const { container } = setup();
    assert({
      given: 'a parent with an open and a done leaf, and a loose open leaf',
      should: 'head each group with where it lives, list only open leaves, then what was done today',
      actual: sectionRows(container),
      expected: [
        { group: 'Plan launch', heading: 'Plan launch', rows: [{ id: 'a', checked: 'false' }] },
        { group: 'Launch', heading: 'Launch', rows: [{ id: 'z', checked: 'false' }] },
        { group: 'Done today', heading: 'Done today1', rows: [{ id: 'b', checked: 'true' }] },
      ],
    });
  });

  test('nothing open, nothing done', () => {
    const { container } = setup(list('l1', [], { title: 'Launch' }));
    assert({
      given: 'an empty list',
      should: 'say nothing is open and that nothing is done yet today',
      actual: [...container.querySelectorAll('p')].map((line) => line.textContent),
      expected: ['Nothing open in Launch.', 'Nothing done yet today.'],
    });
  });

  test('ticking a row', () => {
    const { container, calls } = setup();
    click(container.querySelector('[aria-label="Complete Draft copy"]') as HTMLButtonElement);
    click(container.querySelector('[aria-label="Complete Pick date"]') as HTMLButtonElement);
    assert({
      given: 'an open leaf ticked and a done one unticked',
      should: 'toggle each by its id',
      actual: calls.completed,
      expected: ['a', 'b'],
    });
  });

  test('the capture row', () => {
    const { container, calls } = setup();
    const open = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Add task to Launch',
    );
    if (open) click(open);
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Add task to Launch"]');
    if (field) {
      typeInto(field, '  Order banners ');
      press(field, 'Enter');
    }
    assert({
      given: 'a title typed into the capture row',
      should: 'capture it, trimmed, into the selected list',
      actual: calls.captured,
      expected: ['Order banners'],
    });
  });

  test('a refusal', () => {
    const { container } = setup(launch(), { notice: { at: 'a', message: 'Task not found' } });
    const capture = setup(launch(), { notice: { at: 'l1', message: 'Title is required' } }).container;
    assert({
      given: 'a refused tick, and a refused capture',
      should: 'say why under the row, or under the capture row',
      actual: [
        container.querySelector('li[data-task="a"] [role="status"]')?.textContent,
        capture.querySelector('[data-capture] [role="status"]')?.textContent,
      ],
      expected: ['Task not found', 'Title is required'],
    });
  });
});
