/**
 * Which controls may act before the permission answer arrives.
 *
 * The sheet is the first thing to ask about a list's permissions on the
 * dashboard, so there is a window where the answer is unknown. Controls whose
 * worst case is a refused click stay enabled through it — greying everything
 * out on open and lighting it up a beat later reads as broken.
 *
 * Two controls must NOT get that benefit of the doubt, because acting early
 * writes rather than failing:
 *
 *  - The description editor autosaves through usePageContent, which has no
 *    permission check of its own: it debounces and PATCHes. It also PATCHes the
 *    TASK's page while the permission consulted here is the parent LIST's, so
 *    an early save is not even guarded by the same resource — for a member with
 *    edit on the task and view-only on the list the write would SUCCEED.
 *  - TaskAgentTriggersDialog PUTs and DELETEs unguarded, and is mounted on the
 *    same flag, so flipping it off would unmount the dialog mid-edit.
 *
 * This test exists because that distinction is invisible: every one of these
 * controls looks the same in the JSX, and collapsing the two booleans into one
 * optimistic value type-checks, passes every other test, and reopens the hole.
 */
import React from 'react';
import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from '@/hooks/__tests__/riteway';
import { render, screen } from '@testing-library/react';
import type { Task } from '../types';

const permissionsState = { permissions: null as { canEdit: boolean } | null, isLoading: true };
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => permissionsState,
  canManageDrive: () => false,
}));
vi.mock('@/hooks/usePageContent', () => ({
  usePageContent: () => ({ content: '', isLoading: false, save: vi.fn(), flush: vi.fn() }),
}));
// Surfaces the prop the whole distinction turns on. The real editor blocks
// writes two ways off it — `editable: !readOnly` and an `if (!readOnly)` guard
// on onUpdate — so asserting the prop is asserting the gate.
vi.mock('@/components/editors/RichEditor', () => ({
  __esModule: true,
  default: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="description-editor" data-readonly={String(!!readOnly)} />
  ),
}));

import { TaskDetailSheet } from '../TaskDetailSheet';

const task: Task = {
  id: 't1', userId: 'u1', assigneeId: null, assigneeAgentId: null,
  pageId: 'task-page-1', title: 'Ship the release notes',
  status: 'pending', priority: 'medium', position: 0,
  dueDate: null, completedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  assignee: null, assigneeAgent: null, user: null, page: null,
  driveId: 'drive-1', taskListPageId: 'list-page-1',
};

const noop = () => {};
const renderSheet = () => render(
  <TaskDetailSheet
    task={task} statusConfigs={[]} open onOpenChange={noop}
    onStatusChange={noop} onPriorityChange={noop} onToggleComplete={noop}
    onMultiAssigneeChange={noop} onDueDateChange={noop} onSaveTitle={noop}
    onDelete={noop} onNavigate={noop}
  />,
);

beforeEach(() => {
  permissionsState.permissions = null;
  permissionsState.isLoading = true;
});

describe('while the permission answer is still in flight', () => {
  it('leaves the completion checkbox usable', () => {
    renderSheet();
    assert({
      given: 'permissions still loading',
      should: 'not disable a control whose worst case is a refused click',
      actual: screen.getByRole('checkbox').hasAttribute('disabled'),
      expected: false,
    });
  });

  it('keeps the description editor read-only', async () => {
    renderSheet();
    const editor = await screen.findByTestId('description-editor');
    assert({
      given: 'permissions still loading',
      should: 'refuse the editor, whose autosave PATCHes with no guard of its own',
      actual: editor.getAttribute('data-readonly'),
      expected: 'true',
    });
  });

  it('does not offer the trigger editor', () => {
    renderSheet();
    assert({
      given: 'permissions still loading',
      should: 'withhold Triggers, which PUTs and DELETEs unguarded',
      actual: screen.queryByRole('button', { name: /triggers/i }) === null,
      expected: true,
    });
  });
});

describe('once the viewer is known to have edit', () => {
  it('offers the trigger editor', () => {
    permissionsState.permissions = { canEdit: true };
    permissionsState.isLoading = false;
    renderSheet();
    assert({
      given: 'a definite yes',
      should: 'show Triggers',
      actual: screen.queryByRole('button', { name: /triggers/i }) !== null,
      expected: true,
    });
  });

  it('lets the description editor write', async () => {
    permissionsState.permissions = { canEdit: true };
    permissionsState.isLoading = false;
    renderSheet();
    const editor = await screen.findByTestId('description-editor');
    assert({
      given: 'a definite yes',
      should: 'make the editor writable',
      actual: editor.getAttribute('data-readonly'),
      expected: 'false',
    });
  });
});

describe('once the viewer is known to be read-only', () => {
  it('disables the click controls too', () => {
    permissionsState.permissions = { canEdit: false };
    permissionsState.isLoading = false;
    renderSheet();
    assert({
      given: 'a definite no',
      should: 'disable the completion checkbox',
      actual: screen.getByRole('checkbox').hasAttribute('disabled'),
      expected: true,
    });
  });
});
