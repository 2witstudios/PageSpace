import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  taskAssigneeOptionClass,
  taskAssigneesClass,
  taskAssigneesGroupClass,
  taskAssigneesMenuClass,
  taskAssigneesSummaryClass,
  taskClearClass,
  taskControlClass,
  taskDescriptionClass,
  taskDetailClass,
  taskDetailCrumbsClass,
  taskDetailMessageClass,
  taskDetailNoticeClass,
  taskDetailTitleClass,
  taskDetailTitleRowClass,
  taskFieldClass,
  taskFieldLabelClass,
  taskFieldValueClass,
  taskFieldsClass,
  taskSectionClass,
  taskSectionHeadingClass,
  taskUnassignedClass,
} from './task-detail-class';

describe('task detail classes', () => {
  test('layout', () => {
    assert({
      given: 'the task detail’s frame',
      should: 'sit in the document column with its title on one bold line',
      actual: [taskDetailClass, taskDetailCrumbsClass, taskDetailTitleRowClass, taskDetailTitleClass],
      expected: [
        'mx-auto flex w-full max-w-doc flex-col gap-4 px-8 py-6',
        'flex min-w-0 items-center gap-1 text-sm text-ink-muted',
        'flex items-center gap-3',
        'min-w-0 flex-1 bg-transparent text-doc-title leading-tight font-bold tracking-doc-title text-ink outline-none',
      ],
    });
  });

  test('fields', () => {
    assert({
      given: 'the field row',
      should: 'give every field one quiet control shape',
      actual: [taskFieldsClass, taskFieldClass, taskFieldLabelClass, taskFieldValueClass, taskControlClass, taskClearClass],
      expected: [
        'flex flex-wrap gap-x-6 gap-y-3 border-b border-hairline pb-4',
        'flex flex-col gap-1',
        'text-2xs text-ink-faint',
        'flex items-center gap-2',
        'rounded-md border border-hairline bg-transparent px-2 py-1 text-sm text-ink transition-colors duration-120 ease-standard hover:border-border-strong',
        'cursor-pointer text-2xs text-ink-faint hover:text-ink',
      ],
    });
  });

  test('assignees', () => {
    assert({
      given: 'the assignee picker',
      should: 'open a raised popover from a control-shaped summary',
      actual: [
        taskAssigneesClass,
        taskAssigneesSummaryClass,
        taskUnassignedClass,
        taskAssigneesMenuClass,
        taskAssigneesGroupClass,
        taskAssigneeOptionClass,
      ],
      expected: [
        'relative',
        'rounded-md border border-hairline bg-transparent px-2 py-1 text-sm text-ink transition-colors duration-120 ease-standard hover:border-border-strong summary-plain flex cursor-pointer items-center gap-2',
        'text-ink-faint',
        'absolute z-popover mt-1 flex w-popover flex-col gap-1 rounded-lg border border-hairline bg-background p-2 shadow-ambient',
        'px-1 text-2xs font-semibold text-ink-faint',
        'flex items-center gap-2 p-1 text-sm text-ink',
      ],
    });
  });

  test('sections and messages', () => {
    assert({
      given: 'the description, subtasks and what the detail says',
      should: 'head each section quietly and say refusals in the live colour',
      actual: [taskSectionClass, taskSectionHeadingClass, taskDescriptionClass, taskDetailNoticeClass, taskDetailMessageClass],
      expected: [
        'flex flex-col gap-2',
        'text-xs font-semibold text-ink-faint',
        'min-h-description w-full rounded-md text-sm leading-normal whitespace-pre-wrap text-ink outline-none',
        'text-xs font-medium text-live',
        'px-6 py-4 text-sm text-ink-muted',
      ],
    });
  });
});
