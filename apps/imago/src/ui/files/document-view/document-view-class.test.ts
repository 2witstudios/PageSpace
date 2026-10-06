import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  documentBodyClass,
  documentColumnClass,
  documentCrumbClass,
  documentCrumbCurrentClass,
  documentCrumbLinkClass,
  documentCrumbsClass,
  documentProseClasses,
  documentScrollClass,
  documentTitleClass,
  documentViewClass,
} from './document-view-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');
const appRoot = join(appDir, '..', '..');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: appRoot }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.document.css'),
  });
  return result.css;
};

/** A class's selector as Tailwind escapes it; variants only prefix it, so the base name is what is searched. */
const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

const everyClass = [
  documentViewClass,
  documentCrumbsClass,
  documentCrumbClass,
  documentCrumbLinkClass,
  documentCrumbCurrentClass,
  documentScrollClass,
  documentColumnClass,
  documentTitleClass,
  documentBodyClass,
  ...Object.values(documentProseClasses),
];

describe('document view classes', () => {
  test('exact strings', () => {
    assert({
      given: 'the document object’s frame',
      should: 'centre the content in the doc reading column under a fixed header, with the doc title type',
      actual: [documentViewClass, documentScrollClass, documentColumnClass, documentTitleClass, documentBodyClass],
      expected: [
        'flex h-full w-full min-w-0 flex-col',
        'min-h-0 flex-1 overflow-y-auto px-8 py-6',
        'mx-auto flex w-full max-w-doc flex-col gap-4',
        'text-doc-title leading-tight font-bold tracking-doc-title text-ink',
        'flex min-w-0 flex-col gap-3 text-md leading-normal break-words whitespace-pre-wrap text-ink outline-none',
      ],
    });
  });

  test('every class is a theme class', async () => {
    const classes = [...new Set(everyClass.flatMap((value) => value.split(' ')))];
    const css = await compile(classes);
    assert({
      given: 'every class the document view and its prose use',
      should: 'each generate CSS from the imago theme (none is an unknown or default-theme class)',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
