// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { TaskKanbanView } from './TaskKanbanView';
import type { TaskHandlers, TaskItem, TaskStatusConfig } from './task-list-types';

afterEach(unmountAll);

const config = (slug: string, name: string, group: TaskStatusConfig['group'], position: number): TaskStatusConfig => ({
  id: `cfg-${slug}`,
  taskListId: 'list',
  name,
  slug,
  color: 'bg-slate-100 text-slate-700',
  group,
  position,
});

// Deliberately out of position order: the board must sort by position, not by array order.
const statusConfigs: TaskStatusConfig[] = [
  config('in_progress', 'In Progress', 'in_progress', 1),
  config('pending', 'Not Started', 'todo', 0),
  config('completed', 'Done', 'done', 2),
];

const task = (overrides: Partial<TaskItem> & Pick<TaskItem, 'id' | 'title' | 'status'>): TaskItem => ({
  userId: 'u1',
  assigneeId: null,
  assigneeAgentId: null,
  pageId: null,
  priority: 'medium',
  position: 0,
  dueDate: null,
  completedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const handlers = (): TaskHandlers => ({
  onToggleComplete: vi.fn(),
  onStatusChange: vi.fn(),
  onPriorityChange: vi.fn(),
  onAssigneeChange: vi.fn(),
  onDueDateChange: vi.fn(),
  onSaveTitle: vi.fn(),
  onDelete: vi.fn(),
  onNavigate: vi.fn(),
  onStartEdit: vi.fn(),
  onConfigureTriggers: vi.fn(),
});

const render = (tasks: TaskItem[], canEdit = true) =>
  mount(
    createElement(TaskKanbanView, {
      tasks,
      driveId: 'drive',
      canEdit,
      handlers: handlers(),
      editingTaskId: null,
      editingTitle: '',
      onEditingTitleChange: vi.fn(),
      onCancelEdit: vi.fn(),
      onCreateTask: vi.fn(),
      statusConfigs,
    }),
  );

const columnNames = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="region"]')].map((region) => region.getAttribute('aria-label'));

describe('TaskKanbanView', () => {
  test('renders one column per status config in position order', () => {
    const container = render([]);
    assert({
      given: 'status configs given out of position order',
      should: 'render the columns in position order',
      actual: columnNames(container),
      expected: ['Not Started', 'In Progress', 'Done'],
    });
  });

  test('shows each column with its name, task count and status group', () => {
    const container = render([
      task({ id: 'a', title: 'Draft', status: 'pending' }),
      task({ id: 'b', title: 'Ship', status: 'pending' }),
    ]);
    const heading = container.querySelector('[role="region"][aria-label="Not Started"] [role="heading"]');
    assert({
      given: 'two tasks in the first column',
      should: 'label the column with its name, its count and its group',
      actual: {
        label: heading?.getAttribute('aria-label'),
        group: heading?.textContent?.includes('To do'),
      },
      expected: { label: 'Not Started, 2 tasks', group: true },
    });
  });

  test('shows "No date" for a card without a due date and a short date for one with it', () => {
    const container = render([
      task({ id: 'a', title: 'Undated', status: 'pending' }),
      task({ id: 'b', title: 'Dated', status: 'pending', dueDate: '2026-11-14T12:00:00.000Z' }),
    ]);
    const cards = [...container.querySelectorAll('[role="article"]')];
    const dueOf = (title: string) =>
      cards.find((card) => card.getAttribute('aria-label') === title)?.textContent ?? '';
    assert({
      given: 'one card with no due date and one with a due date',
      should: 'show "No date" for the first and the month and day for the second',
      actual: {
        undated: dueOf('Undated').includes('No date'),
        dated: /Nov/.test(dueOf('Dated')),
      },
      expected: { undated: true, dated: true },
    });
  });

  test('shows sub-task progress on a card that has sub-tasks', () => {
    const container = render([
      task({ id: 'a', title: 'Parent', status: 'in_progress', subTaskCount: 3, subTaskCompletedCount: 1 }),
    ]);
    const card = container.querySelector('[role="article"][aria-label="Parent"]');
    assert({
      given: 'a card with three sub-tasks, one complete',
      should: 'show the 1/3 progress on the card',
      actual: card?.textContent?.includes('1/3') ?? false,
      expected: true,
    });
  });

  test('shows the trigger badge with the active trigger count, to editors only', () => {
    const editor = render([task({ id: 'a', title: 'Watched', status: 'pending', activeTriggerCount: 2 })]);
    const viewer = render([task({ id: 'a', title: 'Watched', status: 'pending', activeTriggerCount: 2 })], false);
    assert({
      given: 'a card with two active triggers, seen by an editor and by a viewer',
      should: 'show the count to the editor and hide the badge from the viewer',
      actual: {
        editor: editor.querySelector('button[aria-label="Agent trigger configured — click to edit"]')?.textContent,
        viewer: viewer.querySelector('button[aria-label="Agent trigger configured — click to edit"]') !== null,
      },
      expected: { editor: '2', viewer: false },
    });
  });

  test('offers Add in every column to editors only', () => {
    const editor = render([]);
    const viewer = render([], false);
    const addButtons = (container: HTMLElement) =>
      [...container.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label')?.startsWith('Add task to'));
    assert({
      given: 'the three status columns for an editor and for a viewer',
      should: 'offer one Add control per column to the editor only',
      actual: { editor: addButtons(editor).length, viewer: addButtons(viewer).length },
      expected: { editor: 3, viewer: 0 },
    });
  });
});
