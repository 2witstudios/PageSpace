import { describe, it, expect } from 'vitest';
import type { TaskItem, TaskStatusConfig } from '../task-list-types';
import {
  rootNodePath,
  makeNodePath,
  isNodeExpanded,
  toggleNodePath,
  canExpandNode,
  depthIndentStyle,
  resolveNodeStatusConfigs,
  formatSubTaskProgress,
  MAX_TASK_DEPTH,
  MAX_ADDABLE_DEPTH,
  canAddSubTaskAt,
  DEPTH_INDENT_PX,
} from '../task-tree-core';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const task = (over: Partial<TaskItem> & { id: string }): TaskItem => ({
  userId: 'u1',
  assigneeId: null,
  assigneeAgentId: null,
  pageId: `page-${over.id}`,
  title: over.id,
  status: 'pending',
  priority: 'medium',
  position: 0,
  dueDate: null,
  completedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const config = (slug: string, over: Partial<TaskStatusConfig> = {}): TaskStatusConfig => ({
  id: `cfg-${slug}`,
  taskListId: 'list-1',
  name: slug,
  slug,
  color: '#000',
  group: 'todo',
  position: 0,
  ...over,
});

describe('node paths', () => {
  it('builds a path from the root page id', () => {
    assert({
      given: 'a root list page id and two levels of task id',
      should: 'join them with separators in order',
      actual: makeNodePath(makeNodePath(rootNodePath('root'), 'a'), 'b'),
      expected: 'root/a/b',
    });
  });

  it('toggles a path without mutating the input set', () => {
    const input = new Set(['root/a']);
    const next = toggleNodePath(input, 'root/b');
    assert({
      given: 'a set that does not contain the path',
      should: 'return a new set containing it and leave the input untouched',
      actual: [next.has('root/b'), input.has('root/b'), next === input],
      expected: [true, false, false],
    });
  });

  it('removes a path already present', () => {
    assert({
      given: 'a set that already contains the path',
      should: 'return a set without it',
      actual: isNodeExpanded(toggleNodePath(new Set(['root/a']), 'root/a'), 'root/a'),
      expected: false,
    });
  });
});

describe('canExpandNode', () => {
  it('expands a task with sub-tasks', () => {
    assert({
      given: 'a task with one sub-task at depth 0',
      should: 'be expandable',
      actual: canExpandNode(task({ id: 'a', subTaskCount: 1 }), 0),
      expected: true,
    });
  });

  it('expands a task with document content and no sub-tasks', () => {
    assert({
      given: 'a leaf task that has content',
      should: 'be expandable',
      actual: canExpandNode(task({ id: 'a', hasContent: true, subTaskCount: 0 }), 0),
      expected: true,
    });
  });

  it('refuses a bare leaf', () => {
    assert({
      given: 'a task with no content and no sub-tasks',
      should: 'not be expandable',
      actual: canExpandNode(task({ id: 'a', hasContent: false, subTaskCount: 0 }), 0),
      expected: false,
    });
  });

  it('refuses a task with no linked page', () => {
    assert({
      given: 'a task whose pageId is null',
      should: 'not be expandable even with sub-tasks',
      actual: canExpandNode(task({ id: 'a', pageId: null, subTaskCount: 3 }), 0),
      expected: false,
    });
  });

  it('allows the last permitted depth and refuses the one past it', () => {
    const t = task({ id: 'a', subTaskCount: 1 });
    assert({
      given: 'depths one below, at, and above the ceiling',
      should: 'permit only the depth below the ceiling',
      actual: [
        canExpandNode(t, MAX_TASK_DEPTH - 1),
        canExpandNode(t, MAX_TASK_DEPTH),
        canExpandNode(t, MAX_TASK_DEPTH + 1),
      ],
      expected: [true, false, false],
    });
  });
});

describe('canAddSubTaskAt', () => {
  it('permits creation up to the ceiling and refuses past it', () => {
    // One rule, phrased in terms of the CREATED task's depth. The two callers
    // hold different depths — a row knows its own, a child list knows its
    // children's — and comparing their raw expressions reads like an
    // off-by-one, which is exactly how this got queried in review.
    assert({
      given: 'depths below, at, and above the addable ceiling',
      should: 'permit only up to and including the ceiling',
      actual: [
        canAddSubTaskAt(MAX_ADDABLE_DEPTH - 1),
        canAddSubTaskAt(MAX_ADDABLE_DEPTH),
        canAddSubTaskAt(MAX_ADDABLE_DEPTH + 1),
      ],
      expected: [true, true, false],
    });
  });

  it('leaves anything it permits still expandable', () => {
    // The point of the ceiling: a task created at the deepest addable level has
    // to be reachable inline, so it must sit below the expansion limit.
    assert({
      given: 'the deepest depth at which a task may be created',
      should: 'still be a depth that can expand',
      actual: canAddSubTaskAt(MAX_ADDABLE_DEPTH) && MAX_ADDABLE_DEPTH < MAX_TASK_DEPTH,
      expected: true,
    });
  });
});

describe('depthIndentStyle', () => {
  it('scales with depth', () => {
    assert({
      given: 'depths 0, 1 and 3',
      should: 'indent by the per-level step',
      actual: [depthIndentStyle(0), depthIndentStyle(1), depthIndentStyle(3)],
      expected: [
        { paddingLeft: '0px' },
        { paddingLeft: `${DEPTH_INDENT_PX}px` },
        { paddingLeft: `${DEPTH_INDENT_PX * 3}px` },
      ],
    });
  });

  it('never produces a negative indent', () => {
    assert({
      given: 'a negative depth',
      should: 'clamp to zero',
      actual: depthIndentStyle(-2),
      expected: { paddingLeft: '0px' },
    });
  });
});

describe('resolveNodeStatusConfigs', () => {
  const root = [config('todo'), config('shipped', { group: 'done' })];

  it('inherits the root vocabulary when the node list defines every root slug', () => {
    const node = [
      config('todo', { taskListId: 'sub', name: 'To do (sub)' }),
      config('shipped', { taskListId: 'sub', group: 'done' }),
    ];
    assert({
      given: 'a node list defining every root slug',
      should: 'return the root configs so labels and colours inherit',
      actual: resolveNodeStatusConfigs(root, node) === root,
      expected: true,
    });
  });

  it('falls back to the node vocabulary when one root slug is missing', () => {
    // Rendering `shipped` here would produce a slug the PATCH route rejects with
    // a 400, because it validates against the SUB-list's configs.
    const node = [config('todo', { taskListId: 'sub' })];
    assert({
      given: 'a node list missing one of the root slugs',
      should: 'return the node configs, every option of which the server accepts',
      actual: resolveNodeStatusConfigs(root, node) === node,
      expected: true,
    });
  });

  it('returns the node configs when the root has none', () => {
    const node = [config('todo', { taskListId: 'sub' })];
    assert({
      given: 'an empty root vocabulary',
      should: 'return the node configs',
      actual: resolveNodeStatusConfigs([], node) === node,
      expected: true,
    });
  });
});

describe('formatSubTaskProgress', () => {
  it('is null for a task with no sub-tasks', () => {
    assert({
      given: 'a task with zero sub-tasks',
      should: 'return null rather than a 0/0 label',
      actual: formatSubTaskProgress({ subTaskCount: 0, subTaskCompletedCount: 0 }),
      expected: null,
    });
  });

  it('formats a partial ratio', () => {
    assert({
      given: 'one of four sub-tasks complete',
      should: 'report the label and the ratio',
      actual: formatSubTaskProgress({ subTaskCount: 4, subTaskCompletedCount: 1 }),
      expected: { label: '1/4', ratio: 0.25 },
    });
  });

  it('clamps a completed count above the total', () => {
    assert({
      given: 'a completed count larger than the total',
      should: 'clamp to the total rather than report 3/2',
      actual: formatSubTaskProgress({ subTaskCount: 2, subTaskCompletedCount: 3 }),
      expected: { label: '2/2', ratio: 1 },
    });
  });
});

