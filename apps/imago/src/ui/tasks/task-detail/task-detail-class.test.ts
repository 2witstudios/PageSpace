import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import * as detail from './task-detail-class';
import {
  taskChipClass,
  taskChipEmptyClass,
  taskChipReadOnlyClass,
  taskChipReadOnlyEmptyClass,
  taskDescriptionClass,
  taskDetailClass,
  taskDetailCrumbsClass,
  taskDetailMessageClass,
  taskDetailNoticeClass,
  taskDetailTitleClass,
  taskDetailTitleRowClass,
  taskDueChipClass,
  taskFieldValueClass,
  taskFieldsClass,
  taskPriorityBarClass,
  taskSectionClass,
  taskSectionHeadingClass,
  taskStatusDotClass,
  taskStatusPillClass,
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
      should: 'wrap one row of hairline chips that firm while their popover is open',
      actual: [taskFieldsClass, taskFieldValueClass, taskChipClass, taskChipEmptyClass.endsWith(' text-ink-faint')],
      expected: [
        'flex flex-wrap items-center gap-2 border-b border-hairline pb-4',
        'flex items-center gap-2',
        'inline-flex h-8 items-center gap-2 rounded-md border border-hairline bg-transparent px-2 text-sm text-ink transition-colors duration-120 ease-standard hover:border-border-strong hover:bg-surface-overlay aria-expanded:border-border-strong aria-expanded:bg-surface-overlay',
        true,
      ],
    });
  });

  test('read-only fields', () => {
    const answers = (value: string): boolean => value.includes('hover:') || value.includes('aria-expanded:');
    assert({
      given: 'the fields as a viewer who may not edit reads them',
      should: 'keep the chip’s shape and tone, and drop everything that answers a pointer',
      actual: [
        answers(taskChipReadOnlyClass),
        answers(taskChipReadOnlyEmptyClass),
        answers(taskStatusPillClass('in_progress', false)),
        answers(taskDueChipClass('overdue', false)),
        taskStatusPillClass('in_progress', false).endsWith('bg-accent-soft text-ink'),
        taskDueChipClass('overdue', false).endsWith('font-medium text-live'),
        taskChipClass.startsWith(taskChipReadOnlyClass),
      ],
      expected: [false, false, false, false, true, true, true],
    });
  });

  test('status, due and priority tones', () => {
    assert({
      given: 'each status group, each due tone and each priority',
      should: 'tint the pill and dot by group, redden an overdue date and a high priority',
      actual: {
        pill: (['todo', 'in_progress', 'done'] as const).map((group) => taskStatusPillClass(group).split(' ').slice(-2).join(' ')),
        dot: (['todo', 'in_progress', 'done'] as const).map((group) => taskStatusDotClass(group).split(' ').at(-1)),
        due: [taskDueChipClass('overdue').endsWith('font-medium text-live'), taskDueChipClass('soon').endsWith('font-medium'), taskDueChipClass(null) === taskChipClass],
        bars: [taskPriorityBarClass(true, 12, 'high'), taskPriorityBarClass(true, 4, 'low'), taskPriorityBarClass(false, 8, 'medium')],
      },
      expected: {
        pill: ['bg-surface-sunken text-ink', 'bg-accent-soft text-ink', 'bg-surface-sunken text-ink-muted'],
        dot: ['bg-ink-faint', 'bg-accent', 'bg-online'],
        due: [true, true, true],
        bars: ['w-1 rounded-sm h-3 bg-live', 'w-1 rounded-sm h-1 bg-ink-muted', 'w-1 rounded-sm h-2 bg-hairline'],
      },
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

  test('every class resolves against the theme', async () => {
    const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');
    const groups = ['todo', 'in_progress', 'done'] as const;
    const lists = [
      ...Object.values(detail).filter((value): value is string => typeof value === 'string'),
      ...groups.flatMap((group) => [taskStatusPillClass(group), taskStatusPillClass(group, false)]),
      ...groups.map(taskStatusDotClass),
      ...(['overdue', 'soon', 'later', null] as const).flatMap((tone) => [taskDueChipClass(tone), taskDueChipClass(tone, false)]),
      ...(['high', 'medium', 'low'] as const).flatMap((priority) => [
        taskPriorityBarClass(true, 4, priority),
        taskPriorityBarClass(false, 8, priority),
        taskPriorityBarClass(true, 12, priority),
      ]),
    ];
    const classes = lists.flatMap((list) => list.split(' ')).filter((cls, index, all) => cls !== '' && all.indexOf(cls) === index);
    const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
    const { css } = await postcss([tailwind({ base: join(appDir, '..', '..') }) as postcss.AcceptedPlugin]).process(source, {
      from: join(appDir, 'globals.task-detail.css'),
    });
    const selectorOf = (cls: string): string => `.${cls.replace(/[:/.[\]=]/g, (char) => `\\${char}`)}`;
    assert({
      given: `the ${classes.length} classes the task detail emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
