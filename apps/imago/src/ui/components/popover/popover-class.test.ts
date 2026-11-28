import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { calendarDayClass, calendarNavClass, datePickerDoneClass, quickPickClass } from '../date-picker/date-picker-class';
import * as datePicker from '../date-picker/date-picker-class';
import { menuCheckClass, menuItemClass, menuLabelClass, popoverContentClass } from './popover-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');
const appRoot = join(appDir, '..', '..');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: appRoot }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.popover.css'),
  });
  return result.css;
};

const selectorOf = (cls: string): string => `.${cls.replace(/[:/.[\]=]/g, (char) => `\\${char}`)}`;

const unique = (lists: readonly string[]): readonly string[] =>
  lists.flatMap((list) => list.split(' ')).filter((cls, index, all) => cls !== '' && all.indexOf(cls) === index);

const dayStates = [true, false].flatMap((selected) =>
  [true, false].flatMap((today) => [true, false].map((outside) => calendarDayClass({ selected, today, outside }))),
);

const classes = unique([
  ...(['popover', 'menu', 'auto'] as const).map(popoverContentClass),
  menuItemClass,
  menuCheckClass,
  menuLabelClass,
  ...dayStates,
  ...(Object.values(datePicker) as readonly unknown[]).filter((value): value is string => typeof value === 'string'),
]);

describe('popover, menu and date picker classes against the theme', () => {
  test('every class resolves', async () => {
    const css = await compile(classes);
    assert({
      given: `the ${classes.length} classes the popover, menu and date picker modules emit`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });

  test('the glass and its rows', () => {
    assert({
      given: 'the popover at each width, a row and the day states',
      should: 'draw the v3 raised glass, light rows on hover or keyboard, and fill the chosen day with the accent',
      actual: {
        popover: popoverContentClass('popover'),
        menu: popoverContentClass('menu').endsWith(' w-menu'),
        auto: popoverContentClass('auto').split(' ').some((cls) => cls.startsWith('w-')),
        row: menuItemClass.includes('data-highlighted:bg-surface-overlay'),
        chosen: calendarDayClass({ selected: true, today: true, outside: false }).endsWith('bg-accent font-semibold text-accent-ink'),
        today: calendarDayClass({ selected: false, today: true, outside: false }).endsWith('font-semibold text-accent'),
        outside: calendarDayClass({ selected: false, today: false, outside: true }).endsWith('text-ink-faint'),
        controls: [quickPickClass, calendarNavClass, datePickerDoneClass].every((cls) => cls.includes('duration-120')),
      },
      expected: {
        popover:
          'z-popover flex flex-col gap-1 rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised outline-none w-popover',
        menu: true,
        auto: false,
        row: true,
        chosen: true,
        today: true,
        outside: true,
        controls: true,
      },
    });
  });
});
