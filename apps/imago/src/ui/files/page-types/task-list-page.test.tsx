// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import type { TaskListToolsControls } from '@/retained/components/layout/middle-content/page-views/task-list/TaskListView';
import { TaskListToolsStrip } from './task-list-page';

vi.mock('next/dynamic', async () => {
  const { createElement: h } = await import('react');
  return { default: () => () => h('div', { 'data-testid': 'task-list-view' }) };
});

afterEach(unmountAll);

const controls = (overrides: Partial<TaskListToolsControls> = {}): TaskListToolsControls => ({
  viewMode: 'table',
  onViewModeChange: vi.fn(),
  filter: 'active',
  onFilterChange: vi.fn(),
  canEdit: true,
  statusSettings: createElement('button', { 'aria-label': 'Status settings' }),
  onNewTask: vi.fn(),
  searchField: createElement('input', { 'aria-label': 'Filter tasks' }),
  canManageWorkflows: false,
  onOpenWorkflows: vi.fn(),
  ...overrides,
});

describe('TaskListToolsStrip', () => {
  test('renders the List controls strip with the View and Status groups', () => {
    const container = mount(createElement(TaskListToolsStrip, { controls: controls() }));
    assert({
      given: 'a task list in table view',
      should: 'label the strip "List controls" and expose the View and Status groups',
      actual: {
        strip: container.querySelector('[role="toolbar"]')?.getAttribute('aria-label'),
        groups: [...container.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label')),
      },
      expected: { strip: 'List controls', groups: ['View', 'Status group'] },
    });
  });

  test('marks Table as the current view and Board as switchable', () => {
    const container = mount(createElement(TaskListToolsStrip, { controls: controls({ viewMode: 'table' }) }));
    const table = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Table');
    const board = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Board');
    assert({
      given: 'table view',
      should: 'mark Table aria-current and leave Board unmarked',
      actual: { table: table?.getAttribute('aria-current'), board: board?.getAttribute('aria-current') ?? null },
      expected: { table: 'page', board: null },
    });
  });

  test('switches to board view when Board is pressed', () => {
    const onViewModeChange = vi.fn();
    const container = mount(createElement(TaskListToolsStrip, { controls: controls({ onViewModeChange }) }));
    const board = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Board');
    if (board) click(board);
    assert({
      given: 'the Board button in the View group',
      should: 'request the kanban view once',
      actual: onViewModeChange.mock.calls,
      expected: [['kanban']],
    });
  });

  test('presses the Status filter that is in effect and sets the one clicked', () => {
    const onFilterChange = vi.fn();
    const container = mount(createElement(TaskListToolsStrip, { controls: controls({ filter: 'active', onFilterChange }) }));
    const pressed = [...container.querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent);
    const completed = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Completed');
    if (completed) click(completed);
    assert({
      given: 'the active filter in effect',
      should: 'press Active and report Completed when it is clicked',
      actual: { pressed, calls: onFilterChange.mock.calls },
      expected: { pressed: ['Active'], calls: [['completed']] },
    });
  });

  test('offers + Task only to editors and runs the new-task action', () => {
    const onNewTask = vi.fn();
    const viewer = mount(createElement(TaskListToolsStrip, { controls: controls({ canEdit: false }) }));
    const editor = mount(createElement(TaskListToolsStrip, { controls: controls({ onNewTask }) }));
    const task = [...editor.querySelectorAll('button')].find((b) => b.textContent === 'Task');
    if (task) click(task);
    assert({
      given: 'a viewer and an editor of the list',
      should: 'show + Task to the editor only, and call onNewTask on click',
      actual: {
        viewer: [...viewer.querySelectorAll('button')].some((b) => b.textContent === 'Task'),
        editor: task !== undefined,
        calls: onNewTask.mock.calls.length,
      },
      expected: { viewer: false, editor: true, calls: 1 },
    });
  });

  test('places the filter box the page supplies inside the strip', () => {
    const container = mount(createElement(TaskListToolsStrip, { controls: controls() }));
    const filter = container.querySelector('input[aria-label="Filter tasks"]');
    assert({
      given: 'a page that supplies its filter box',
      should: 'render that filter box inside the List controls strip',
      actual: filter !== null && container.querySelector('[role="toolbar"]')?.contains(filter) === true,
      expected: true,
    });
  });

  test('shows Workflows to drive managers only and opens the workflows dialog', () => {
    const onOpenWorkflows = vi.fn();
    const manager = mount(createElement(TaskListToolsStrip, { controls: controls({ canManageWorkflows: true, onOpenWorkflows }) }));
    const viewer = mount(createElement(TaskListToolsStrip, { controls: controls({ canManageWorkflows: false }) }));
    const workflows = [...manager.querySelectorAll('button')].find((b) => b.textContent === 'Workflows');
    if (workflows) click(workflows);
    assert({
      given: 'a drive manager and a viewer of the list',
      should: 'show Workflows to the manager only, and open the dialog on click',
      actual: {
        manager: workflows !== undefined,
        viewer: [...viewer.querySelectorAll('button')].some((b) => b.textContent === 'Workflows'),
        calls: onOpenWorkflows.mock.calls.length,
      },
      expected: { manager: true, viewer: false, calls: 1 },
    });
  });

  test('leaves the board Assignee and Due menus out, since classic has no filter for them', () => {
    const container = mount(createElement(TaskListToolsStrip, { controls: controls() }));
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent);
    assert({
      given: 'the strip with no assignee or due filter behind it',
      should: 'not render Assignee or Due controls',
      actual: labels.filter((l) => l === 'Assignee' || l === 'Due'),
      expected: [],
    });
  });
});
