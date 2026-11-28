import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { findElement } from '../../test-support/find-element';
import {
  handoffActionsClass,
  handoffCardClass,
  handoffClass,
  handoffDetailClass,
  handoffGlyphClass,
  handoffLinkClass,
  handoffTitleClass,
  handoffTypeClass,
} from './classic-handoff-class';
import { renderHandoff, type HandoffRenderProps } from './classic-handoff.render';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: join(appDir, '..', '..') }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.files.css'),
  });
  return result.css;
};

const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

const sheet: HandoffRenderProps = {
  typeLabel: 'Sheet',
  icon: 'sheet',
  title: 'Q3 numbers',
  classicHref: '/dashboard/d1/p1',
  chat: null,
};

type Anchor = { readonly href?: string };

const classicLink = (props: HandoffRenderProps) =>
  findElement<Anchor>(renderHandoff(props), (element) => element.props.href === props.classicHref);

describe('renderHandoff()', () => {
  test('Open in classic is a full navigation', () => {
    const actual = [sheet, { ...sheet, chat: () => {} }].map((props) => {
      const link = classicLink(props);
      return [link?.type, link?.props.href, link?.props.children];
    });
    assert({
      given: 'the card of a page that is no agent, and of an agent',
      should: 'link to classic with a plain anchor, never Next’s Link, so the browser leaves /imago',
      actual,
      expected: [
        ['a', '/dashboard/d1/p1', 'Open in classic'],
        ['a', '/dashboard/d1/p1', 'Open in classic'],
      ],
    });
  });

  test('every class resolves against the theme', async () => {
    const classes = [
      handoffClass,
      handoffCardClass,
      handoffGlyphClass,
      handoffTypeClass,
      handoffTitleClass,
      handoffDetailClass,
      handoffActionsClass,
      handoffLinkClass,
    ]
      .flatMap((list) => list.split(' '))
      .filter((cls, index, all) => all.indexOf(cls) === index);
    const css = await compile(classes);
    assert({
      given: `the ${classes.length} classes the hand-off card emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
