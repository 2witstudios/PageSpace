import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { StatusGroup } from '../task-model/task';
import * as classes from './roadmap-view-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');
const appRoot = join(appDir, '..', '..');

const compile = async (candidates: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${candidates.join(' ')}");`;
  const result = await postcss([tailwind({ base: appRoot }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.primitives.css'),
  });
  return result.css;
};

const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

const groups: readonly StatusGroup[] = ['todo', 'in_progress', 'done'];

/** Every string the module can emit, across every variant. */
const emitted = (): readonly string[] =>
  [
    ...Object.values(classes).flatMap((value: unknown) => (typeof value === 'string' ? [value] : [])),
    ...[0, 1, 2, 3, 4, 9].map(classes.roadmapLaneClass),
    ...groups.flatMap((group) => [
      classes.roadmapDotClass(group),
      classes.roadmapBarClass(group, true),
      classes.roadmapBarClass(group, false),
      classes.roadmapFillClass(group),
      classes.roadmapMilestoneClass(group, true),
    ]),
    classes.roadmapLaneTitleClass(true),
    classes.roadmapLaneTitleClass(false),
    classes.roadmapTickClass(true),
    classes.roadmapTickClass(false),
    classes.roadmapHandleClass('start'),
    classes.roadmapHandleClass('due'),
  ]
    .flatMap((list) => list.split(' '))
    .filter((cls, index, all) => cls !== '' && all.indexOf(cls) === index);

describe('roadmap view classes', () => {
  test('every class resolves against the theme', async () => {
    const all = emitted();
    const css = await compile(all);
    assert({
      given: `the ${all.length} classes the roadmap emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: all.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });

  test('tints by status group', () => {
    assert({
      given: 'a bar to do, in progress and done, and one the viewer cannot edit',
      should: 'fill neutral, accent-soft with an accent border, or the success tone; grab only when editable',
      actual: [
        classes.roadmapBarClass('todo', true),
        classes.roadmapBarClass('in_progress', false),
        classes.roadmapBarClass('done', false),
      ],
      expected: [
        'absolute top-2 flex h-roadmap-bar overflow-hidden rounded-sm border border-border-strong bg-fill cursor-grab touch-none',
        'absolute top-2 flex h-roadmap-bar overflow-hidden rounded-sm border border-accent bg-accent-soft',
        'absolute top-2 flex h-roadmap-bar overflow-hidden rounded-sm border border-status-success/40 bg-status-success/10',
      ],
    });
  });

  test('lanes step in by depth', () => {
    assert({
      given: 'lanes at depths 0, 1 and far below',
      should: 'indent each level, holding the deepest step',
      actual: [0, 1, 9].map((depth) => classes.roadmapLaneClass(depth).split(' ').at(-1)),
      expected: ['pl-3', 'pl-6', 'pl-16'],
    });
  });
});
