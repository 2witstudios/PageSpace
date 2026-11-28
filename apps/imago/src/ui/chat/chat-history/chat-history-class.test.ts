import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { chatHistoryNoteClass, chatHistoryRowClass, chatHistoryTitleClass } from './chat-history-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');
const appRoot = join(appDir, '..', '..');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: appRoot }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.chat-history.css'),
  });
  return result.css;
};

/** A class's selector as Tailwind escapes it; variants only prefix it, so the base name is what is searched. */
const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

describe('chat history classes', () => {
  test('exact strings', () => {
    assert({
      given: 'a past chat, the open one, a row title and a note',
      should: 'draw a quiet 32px row that lifts to full ink on hover and takes the soft accent when open',
      actual: [chatHistoryRowClass(false), chatHistoryRowClass(true), chatHistoryTitleClass, chatHistoryNoteClass],
      expected: [
        'flex h-8 w-full cursor-pointer items-center rounded-lg px-2 text-left text-sm font-normal transition-colors duration-120 ease-standard text-ink-muted hover:bg-surface-overlay hover:text-ink',
        'flex h-8 w-full cursor-pointer items-center rounded-lg px-2 text-left text-sm font-normal transition-colors duration-120 ease-standard bg-accent-soft text-ink',
        'min-w-0 flex-1 truncate',
        'px-2 text-sm text-ink-muted',
      ],
    });
  });

  test('every class resolves against the theme', async () => {
    const classes = [chatHistoryRowClass(false), chatHistoryRowClass(true), chatHistoryTitleClass, chatHistoryNoteClass]
      .flatMap((list) => list.split(' '))
      .filter((cls, index, all) => all.indexOf(cls) === index);
    const css = await compile(classes);
    assert({
      given: `the ${classes.length} classes the chat history emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
