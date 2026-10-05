import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  postComposerClass,
  postComposerEntryClass,
  postComposerErrorClass,
  postComposerFieldClass,
  postComposerSendClass,
} from './post-composer-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: join(appDir, '..', '..') }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.composer.css'),
  });
  return result.css;
};

const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

const parts = [postComposerClass, postComposerEntryClass, postComposerFieldClass, postComposerSendClass, postComposerErrorClass];

describe('post composer classes', () => {
  test('exact classes', () => {
    assert({
      given: 'the composer’s parts',
      should: 'be these exact classes',
      actual: parts,
      expected: [
        'sticky bottom-0 flex flex-col gap-1 pt-2 pb-4',
        'flex items-end gap-2 rounded-xl border border-border bg-surface-raised p-2 shadow-ambient transition-colors duration-120 ease-standard focus-within:border-border-strong',
        'h-16 flex-1 resize-none border-none bg-transparent px-2 py-1 text-base text-ink outline-none placeholder:text-ink-faint',
        'flex size-control flex-none cursor-pointer items-center justify-center rounded-round bg-send text-send-ink transition-colors duration-120 ease-standard disabled:cursor-default disabled:opacity-50',
        'px-2 text-xs text-warn',
      ],
    });
  });

  test('every class resolves against the theme', async () => {
    const classes = parts.flatMap((list) => list.split(' ')).filter((cls, index, all) => all.indexOf(cls) === index);
    const css = await compile(classes);
    assert({
      given: `the ${classes.length} classes the post composer emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
