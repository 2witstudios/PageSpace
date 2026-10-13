import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  messageGlyphClass,
  messageNameClass,
  messageRowClass,
  messagesNoteClass,
} from './messages-pane-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: join(appDir, '..', '..') }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.messages.css'),
  });
  return result.css;
};

const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

const base =
  'flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm no-underline transition-colors duration-120 ease-standard hover:no-underline';

describe('messageRowClass()', () => {
  test('a quiet row', () => {
    assert({
      given: 'a row that is neither open nor unread',
      should: 'be a 32px row in muted ink that comes up to full ink on hover',
      actual: messageRowClass({ selected: false, unread: false }),
      expected: `${base} font-normal text-ink-muted hover:bg-surface-overlay hover:text-ink`,
    });
  });

  test('an unread row', () => {
    assert({
      given: 'a row with something unread',
      should: 'lift to medium weight at full ink, the one row that does',
      actual: messageRowClass({ selected: false, unread: true }),
      expected: `${base} font-medium text-ink hover:bg-surface-overlay`,
    });
  });

  test('the open row', () => {
    assert({
      given: 'the open channel or conversation, read or not',
      should: 'take the soft accent tint at full ink, never blue ink',
      actual: [true, false].map((unread) => messageRowClass({ selected: true, unread })),
      expected: [`${base} bg-accent-soft font-normal text-ink`, `${base} bg-accent-soft font-normal text-ink`],
    });
  });
});

describe('message row parts', () => {
  test('exact classes', () => {
    assert({
      given: 'the name, the channel glyph and a section note',
      should: 'truncate the name, keep the glyph faint and the note muted',
      actual: [messageNameClass, messageGlyphClass, messagesNoteClass],
      expected: ['min-w-0 flex-1 truncate', 'flex-none text-ink-faint', 'px-2 text-sm text-ink-muted'],
    });
  });

  test('every class resolves against the theme', async () => {
    const classes = [
      ...[false, true].flatMap((selected) =>
        [false, true].map((unread) => messageRowClass({ selected, unread })),
      ),
      messageNameClass,
      messageGlyphClass,
      messagesNoteClass,
    ]
      .flatMap((list) => list.split(' '))
      .filter((cls, index, all) => all.indexOf(cls) === index);
    const css = await compile(classes);
    assert({
      given: `the ${classes.length} classes the messages pane emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
