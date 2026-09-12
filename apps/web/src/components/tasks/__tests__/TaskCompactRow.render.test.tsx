/**
 * What the compact row actually puts in the DOM.
 *
 * The row replaced a card that disabled every control for a viewer without edit
 * permission. Losing that is invisible to a pure-function test and to types: the
 * write handlers all guard, so the only symptom is a control that moves and a
 * change that never lands.
 */
import React from 'react';
import { describe, it, vi } from 'vitest';
import { assert } from '@/hooks/__tests__/riteway';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskCompactRow } from '../TaskCompactRow';
import type { Task } from '../types';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  userId: 'u1',
  assigneeId: null,
  assigneeAgentId: null,
  pageId: 'p1',
  title: 'Ship the release notes',
  status: 'pending',
  priority: 'medium',
  position: 0,
  dueDate: null,
  completedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  assignee: null,
  assigneeAgent: null,
  user: null,
  page: null,
  ...over,
});

const noop = () => {};

describe('read-only viewers', () => {
  it('disables the checkbox when the viewer cannot edit', () => {
    render(<TaskCompactRow task={task()} onToggleComplete={noop} onTap={noop} canEdit={false} />);
    assert({
      given: 'canEdit false',
      should: 'render the completion checkbox disabled',
      actual: screen.getByRole('checkbox').hasAttribute('disabled'),
      expected: true,
    });
  });

  it('does not fire the write when the viewer cannot edit', async () => {
    const onToggleComplete = vi.fn();
    render(
      <TaskCompactRow task={task()} onToggleComplete={onToggleComplete} onTap={noop} canEdit={false} />,
    );
    // A disabled control has `pointer-events: none`, which userEvent refuses to
    // click by default. Bypassing that check makes the click really reach the
    // element, so a missing `disabled` would show up as a call rather than as a
    // test that quietly skipped its own action.
    await userEvent.click(screen.getByRole('checkbox'), { pointerEventsCheck: 0 });
    assert({
      given: 'a click on the checkbox of a read-only row',
      should: 'not call the completion handler at all',
      actual: onToggleComplete.mock.calls.length,
      expected: 0,
    });
  });

  // The dashboard lists tasks from many lists and has no single permission to
  // apply, so it passes true deliberately and the sheet resolves each task's own.
  it('stays editable when the viewer can edit', () => {
    render(<TaskCompactRow task={task()} onToggleComplete={noop} onTap={noop} canEdit />);
    assert({
      given: 'canEdit true, as the dashboard renders it',
      should: 'leave the checkbox enabled',
      actual: screen.getByRole('checkbox').hasAttribute('disabled'),
      expected: false,
    });
  });
});

describe('completion state', () => {
  it('ticks and strikes a task whose status group is done', () => {
    render(
      <TaskCompactRow
        task={task({ status: 'shipped', statusLabel: 'Shipped', statusColor: 'bg-purple-100', statusGroup: 'done' })}
        onToggleComplete={noop}
        onTap={noop}
        canEdit
      />,
    );
    const title = screen.getByText('Ship the release notes');
    assert({
      given: 'a custom status enriched into the done group',
      should: 'check the box and strike the title through',
      actual: {
        checked: screen.getByRole('checkbox').getAttribute('data-state'),
        struck: title.className.includes('line-through'),
      },
      expected: { checked: 'checked', struck: true },
    });
  });

  it('names the checkbox after the row it belongs to', () => {
    render(<TaskCompactRow task={task()} onToggleComplete={noop} onTap={noop} canEdit />);
    assert({
      given: 'an unfinished task',
      should: 'name the checkbox so a screen reader can tell rows apart',
      actual: screen.getByRole('checkbox').getAttribute('aria-label'),
      expected: 'Complete Ship the release notes',
    });
  });
});

describe('source across drives', () => {
  it('given a drive name, leads the list title with it', () => {
    render(
      <TaskCompactRow
        task={task({ taskListPageTitle: 'Launch Q3' } as Partial<Task>)}
        driveName="Marketing"
        onToggleComplete={noop}
        onTap={noop}
        canEdit
      />
    );
    assert({
      given: 'a task in the All drives focus',
      should: 'name the drive before the list',
      actual: screen.getByText('Marketing › Launch Q3').textContent,
      expected: 'Marketing › Launch Q3',
    });
  });

  it('given no drive name, shows the list title alone', () => {
    render(
      <TaskCompactRow
        task={task({ taskListPageTitle: 'Launch Q3' } as Partial<Task>)}
        onToggleComplete={noop}
        onTap={noop}
        canEdit
      />
    );
    assert({
      given: 'a task in a drive focus',
      should: 'not prefix the list title',
      actual: screen.getByText('Launch Q3').textContent,
      expected: 'Launch Q3',
    });
  });
});
