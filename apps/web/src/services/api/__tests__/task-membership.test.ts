import { describe, it, expect } from 'vitest';
import {
  TASK_LIST_TYPE,
  shouldHaveTaskItem,
  resolveTaskItemSyncAction,
  buildTaskItemInsert,
  selectMissingTaskItemPageIds,
} from '../task-membership';

describe('shouldHaveTaskItem', () => {
  it('is true only when a TASK_LIST page sits under a TASK_LIST parent', () => {
    expect(shouldHaveTaskItem({ pageType: TASK_LIST_TYPE, parentType: TASK_LIST_TYPE })).toBe(true);
  });

  it('is false when the page itself is not a TASK_LIST', () => {
    expect(shouldHaveTaskItem({ pageType: 'DOCUMENT', parentType: TASK_LIST_TYPE })).toBe(false);
  });

  it('is false when the parent is not a TASK_LIST', () => {
    expect(shouldHaveTaskItem({ pageType: TASK_LIST_TYPE, parentType: 'FOLDER' })).toBe(false);
  });

  it('is false when the parent type is null or undefined (root / unknown)', () => {
    expect(shouldHaveTaskItem({ pageType: TASK_LIST_TYPE, parentType: null })).toBe(false);
    expect(shouldHaveTaskItem({ pageType: TASK_LIST_TYPE, parentType: undefined })).toBe(false);
  });
});

describe('resolveTaskItemSyncAction', () => {
  const base = {
    movedPageType: TASK_LIST_TYPE,
    oldParentId: 'old',
    newParentId: 'new',
    oldParentType: TASK_LIST_TYPE,
    newParentType: TASK_LIST_TYPE,
  };

  it('no-ops for non TASK_LIST pages', () => {
    expect(resolveTaskItemSyncAction({ ...base, movedPageType: 'DOCUMENT' })).toEqual({
      shouldRemove: false,
      shouldAdd: false,
    });
  });

  it('no-ops when the parent did not change (pure reorder)', () => {
    expect(
      resolveTaskItemSyncAction({ ...base, oldParentId: 'same', newParentId: 'same' }),
    ).toEqual({ shouldRemove: false, shouldAdd: false });
  });

  it('removes and adds when moving between two TASK_LIST parents', () => {
    expect(resolveTaskItemSyncAction(base)).toEqual({ shouldRemove: true, shouldAdd: true });
  });

  it('only adds when moving from a non-TASK_LIST parent into a TASK_LIST parent', () => {
    expect(
      resolveTaskItemSyncAction({ ...base, oldParentType: 'FOLDER' }),
    ).toEqual({ shouldRemove: false, shouldAdd: true });
  });

  it('only adds when moving from root (no old parent) into a TASK_LIST parent', () => {
    expect(
      resolveTaskItemSyncAction({ ...base, oldParentId: null, oldParentType: null }),
    ).toEqual({ shouldRemove: false, shouldAdd: true });
  });

  it('only removes when moving out of a TASK_LIST parent into a non-TASK_LIST parent', () => {
    expect(
      resolveTaskItemSyncAction({ ...base, newParentType: 'FOLDER' }),
    ).toEqual({ shouldRemove: true, shouldAdd: false });
  });

  it('only removes when moving out of a TASK_LIST parent to root', () => {
    expect(
      resolveTaskItemSyncAction({ ...base, newParentId: null, newParentType: null }),
    ).toEqual({ shouldRemove: true, shouldAdd: false });
  });
});

describe('buildTaskItemInsert', () => {
  it('builds a pending/medium row', () => {
    expect(
      buildTaskItemInsert({ pageId: 'p1', userId: 'u1' }),
    ).toEqual({
      userId: 'u1',
      pageId: 'p1',
      status: 'pending',
      priority: 'medium',
    });
  });

  it('carries no position — ordering lives on the linked page (#2143)', () => {
    expect(buildTaskItemInsert({ pageId: 'p1', userId: 'u1' })).not.toHaveProperty('position');
  });
});

describe('selectMissingTaskItemPageIds', () => {
  it('returns child page ids that have no task item yet, order preserved', () => {
    expect(
      selectMissingTaskItemPageIds({
        childPageIds: ['a', 'b', 'c'],
        existingTaskItemPageIds: ['b'],
      }),
    ).toEqual(['a', 'c']);
  });

  it('returns an empty array when every child already has a task item', () => {
    expect(
      selectMissingTaskItemPageIds({
        childPageIds: ['a', 'b'],
        existingTaskItemPageIds: ['a', 'b'],
      }),
    ).toEqual([]);
  });

  it('dedupes repeated child ids', () => {
    expect(
      selectMissingTaskItemPageIds({
        childPageIds: ['a', 'a', 'b'],
        existingTaskItemPageIds: [],
      }),
    ).toEqual(['a', 'b']);
  });

  it('handles an empty child list', () => {
    expect(
      selectMissingTaskItemPageIds({ childPageIds: [], existingTaskItemPageIds: ['x'] }),
    ).toEqual([]);
  });
});
