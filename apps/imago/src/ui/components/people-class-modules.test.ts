import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  avatarClass,
  avatarImageClass,
  avatarInitialsClass,
  avatarPresenceClass,
  avatarSizes,
} from './avatar/avatar-class';
import {
  avatarGroupClass,
  avatarGroupFaceClass,
  avatarGroupRestClass,
} from './avatar-group/avatar-group-class';
import { presenceDotClass } from './presence-dot/presence-dot-class';
import { unreadCountClass } from './unread-count/unread-count-class';
import { presences } from '../types/presence/presence';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../app');
const appRoot = join(appDir, '..', '..');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([
    tailwind({ base: appRoot }) as postcss.AcceptedPlugin,
  ]).process(source, { from: join(appDir, 'globals.people.css') });
  return result.css;
};

const selectorOf = (cls: string): string =>
  `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

const moduleClasses = [
  ...avatarSizes.flatMap((size) => [avatarClass(size), avatarClass(size, 'agent')]),
  avatarImageClass,
  avatarInitialsClass,
  avatarPresenceClass,
  avatarGroupClass,
  avatarGroupFaceClass,
  avatarGroupRestClass,
  ...presences.map(presenceDotClass),
  unreadCountClass,
]
  .flatMap((list) => list.split(' '))
  .filter((cls, index, all) => all.indexOf(cls) === index);

describe('people class modules against the theme', () => {
  test('every class resolves', async () => {
    const css = await compile(moduleClasses);
    assert({
      given: `the ${moduleClasses.length} classes the avatar, avatar-group, presence-dot and unread-count modules emit`,
      should: 'each generate a rule from the token-locked theme',
      actual: moduleClasses.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });

  test('sizes', async () => {
    const css = await compile([
      'size-avatar-stack',
      '-ml-avatar-overlap',
      'h-unread',
      'min-w-unread',
      'text-badge',
    ]);
    assert({
      given: 'the stacked avatar, its overlap and the unread pill',
      should:
        'be a 24px face pulled back 6px, and a 16px pill with 10px figures',
      actual: [
        /--spacing-avatar-stack: 24px/.test(css) &&
          /\.size-avatar-stack \{\s*width: var\(--spacing-avatar-stack\);\s*height: var\(--spacing-avatar-stack\)/.test(css),
        /--spacing-avatar-overlap: 6px/.test(css) &&
          /\.-ml-avatar-overlap \{\s*margin-left: calc\(var\(--spacing-avatar-overlap\) \* -1\)/.test(css),
        /--spacing-unread: 16px/.test(css) &&
          /\.h-unread \{\s*height: var\(--spacing-unread\)/.test(css) &&
          /\.min-w-unread \{\s*min-width: var\(--spacing-unread\)/.test(css),
        /--text-badge: 0\.625rem/.test(css) &&
          /\.text-badge \{\s*font-size: var\(--text-badge\)/.test(css),
      ],
      expected: [true, true, true, true],
    });
  });
});
