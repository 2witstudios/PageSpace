import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  documentNoticeActionsClass,
  documentNoticeClass,
  documentSaveStateClass,
  documentTitleInputClass,
} from './document-edit-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');
const appRoot = join(appDir, '..', '..');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: appRoot }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.document-edit.css'),
  });
  return result.css;
};

/** A class's selector as Tailwind escapes it; variants only prefix it, so the base name is what is searched. */
const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

describe('document edit classes', () => {
  test('exact strings', () => {
    assert({
      given: 'the editable title, the save state and a save notice',
      should: 'keep the doc title type on the input and quiet tokens on the rest',
      actual: [documentTitleInputClass, documentSaveStateClass, documentNoticeClass, documentNoticeActionsClass],
      expected: [
        'w-full min-w-0 bg-transparent text-doc-title leading-tight font-bold tracking-doc-title text-ink outline-none placeholder:text-ink-muted',
        'min-h-4 text-xs text-ink-muted',
        'flex flex-col gap-2 rounded-lg border border-hairline bg-surface-sunken p-3 text-sm text-ink',
        'flex flex-wrap gap-2',
      ],
    });
  });

  test('every class is a theme class', async () => {
    const every = [documentTitleInputClass, documentSaveStateClass, documentNoticeClass, documentNoticeActionsClass];
    const classes = [...new Set(every.flatMap((value) => value.split(' ')))];
    const css = await compile(classes);
    assert({
      given: 'every class the document editing uses',
      should: 'each generate CSS from the imago theme (none is an unknown or default-theme class)',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
