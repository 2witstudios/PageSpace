// @vitest-environment jsdom
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import { list, parent, task } from '../task-model/fixtures';
import type { Task } from '../task-model/task';
import { dueDateFor } from './due-date';
import { renderTaskDetail, type TaskDetailActions, type TaskDetailRenderProps } from './task-detail.render';

afterEach(unmountAll);

const TODAY = '2026-10-20';

const open = parent('a', [task('s', { title: 'Book venue' })], {
  title: 'Plan launch',
  status: 'in_progress',
  priority: 'high',
  dueDate: dueDateFor('2026-10-23'),
  startDate: dueDateFor('2026-10-21'),
  assignees: [{ type: 'user', id: 'u1', name: 'Ada Lovelace' }],
});

const setup = (canEdit: boolean | undefined, shown: Task = open) => {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: readonly unknown[]): void => {
      calls.push([name, ...args].join(':'));
    };
  const actions: TaskDetailActions = {
    rename: record('rename'),
    toggleComplete: record('toggleComplete'),
    setStatus: record('setStatus'),
    setPriority: record('setPriority'),
    setDueDate: record('setDueDate'),
    setStartDate: record('setStartDate'),
    toggleAssignee: record('toggleAssignee'),
    toggleExpanded: record('toggleExpanded'),
    addTask: record('addTask'),
    remove: record('remove'),
  };
  const props: TaskDetailRenderProps = {
    driveId: 'd1',
    holder: { pageId: 'root', title: 'Launch' },
    path: [shown],
    list: list('root', [shown], { title: 'Launch' }),
    assignable: [],
    notice: null,
    previousHref: null,
    nextHref: null,
    dueSetByImago: false,
    today: TODAY,
    canEdit,
    expandedIds: [],
    hrefFor: (pageId) => `/d1/tasks/${pageId}`,
    description: null,
    automations: null,
    activity: null,
    actions,
  };
  return { container: mount(renderTaskDetail(props)), calls };
};

const fieldsOf = (container: HTMLElement) => {
  const group = container.querySelector('[role="group"][aria-label="Fields"]');
  return {
    buttons: [...(group?.querySelectorAll('button') ?? [])].length,
    text: [...(group?.children ?? [])].map((chip) => chip.textContent),
  };
};

const checkboxes = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].map((box) => ({
    label: box.getAttribute('aria-label'),
    disabled: box.disabled,
  }));

describe('renderTaskDetail()', () => {
  test('a viewer who may edit', () => {
    const { container } = setup(true);
    assert({
      given: 'a task opened by a viewer who may edit its list',
      should: 'offer status, both dates, people and priority as controls, a title to edit, Delete and Add subtask',
      actual: {
        buttons: fieldsOf(container).buttons,
        title: container.querySelector<HTMLInputElement>('input[aria-label="Title"]')?.value,
        delete: container.querySelector('[aria-label="Delete task"]') !== null,
        add: container.textContent?.includes('Add subtask'),
        boxes: checkboxes(container),
      },
      expected: {
        buttons: 5,
        title: 'Plan launch',
        delete: true,
        add: true,
        boxes: [
          { label: 'Mark Plan launch complete', disabled: false },
          { label: 'Complete Book venue', disabled: false },
        ],
      },
    });
  });

  test('a viewer who may only read', () => {
    const { container, calls } = setup(false);
    for (const box of container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')) click(box);
    assert({
      given: 'a task opened by a viewer who may not edit its list',
      should: 'show every field’s value as text, the title as a heading, and nothing that writes',
      actual: {
        fields: fieldsOf(container),
        titleInput: container.querySelector('input[aria-label="Title"]') !== null,
        heading: container.querySelector('h2')?.textContent,
        delete: container.querySelector('[aria-label="Delete task"]') !== null,
        saved: container.textContent?.includes('Saved'),
        add: container.textContent?.includes('Add subtask'),
        boxes: checkboxes(container),
        calls,
      },
      expected: {
        fields: {
          buttons: 0,
          text: ['Status: In Progress', 'Due · Fri 23', 'Start · Wed 21', 'AAda Lovelace', 'Priority: High', 'Launch'],
        },
        titleInput: false,
        heading: 'Plan launch',
        delete: false,
        saved: false,
        add: false,
        boxes: [
          { label: 'Mark Plan launch complete', disabled: true },
          { label: 'Complete Book venue', disabled: true },
        ],
        calls: [],
      },
    });
  });

  test('before the viewer’s permission loads', () => {
    const { container } = setup(undefined);
    assert({
      given: 'a task opened before the server has said whether the viewer may edit',
      should: 'offer the fields, title and ticks as controls, and keep Delete and Add subtask back until it does',
      actual: {
        buttons: fieldsOf(container).buttons,
        title: container.querySelector<HTMLInputElement>('input[aria-label="Title"]')?.value,
        delete: container.querySelector('[aria-label="Delete task"]') !== null,
        add: container.textContent?.includes('Add subtask'),
        boxes: checkboxes(container),
      },
      expected: {
        buttons: 5,
        title: 'Plan launch',
        delete: false,
        add: false,
        boxes: [
          { label: 'Mark Plan launch complete', disabled: false },
          { label: 'Complete Book venue', disabled: false },
        ],
      },
    });
  });

  test('a read-only task with nothing set', () => {
    const { container } = setup(false, task('b', { title: 'Loose end' }));
    assert({
      given: 'a read-only task with no dates and no one on it',
      should: 'say so in faint text rather than offer to set them',
      actual: fieldsOf(container).text.slice(1, 4),
      expected: ['No due date', 'No start date', 'Unassigned'],
    });
  });
});
