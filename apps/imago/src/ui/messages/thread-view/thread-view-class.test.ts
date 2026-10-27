import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  dividerClass,
  dividerLabelClass,
  dividerLineClass,
  dividerNewClass,
  editedClass,
  mentionClass,
  olderClass,
  postAuthorClass,
  postBodyClass,
  postClass,
  postFollowTimeClass,
  postTimeClass,
  reactionClass,
  reactionsClass,
  threadClass,
  threadNoteClass,
  threadTitleClass,
} from './thread-view-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: join(appDir, '..', '..') }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.thread.css'),
  });
  return result.css;
};

const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

describe('postClass()', () => {
  test('flat rows, no bubble', () => {
    assert({
      given: 'a lead post, a follow-up, a lead that mentions the viewer, and the viewer’s post still sending',
      should: 'sit flat on the canvas with a clear edge, space a lead from the group above, fill only the mention with the accent edge, and fade the sending post',
      actual: [
        postClass({ lead: true, mentioned: false }),
        postClass({ lead: false, mentioned: false }),
        postClass({ lead: true, mentioned: true }),
        postClass({ lead: true, mentioned: false, pending: true }),
      ],
      expected: [
        'group flex gap-3 border-l-2 px-2 py-1 mt-3 rounded-lg border-l-transparent hover:bg-surface-overlay',
        'group flex gap-3 border-l-2 px-2 py-1 rounded-lg border-l-transparent hover:bg-surface-overlay',
        'group flex gap-3 border-l-2 px-2 py-1 mt-3 rounded-r-lg border-l-accent bg-accent-soft',
        'group flex gap-3 border-l-2 px-2 py-1 mt-3 rounded-lg border-l-transparent hover:bg-surface-overlay opacity-60',
      ],
    });
  });
});

describe('mentionClass() and reactionClass()', () => {
  test('the viewer’s are marked', () => {
    assert({
      given: 'a mention of someone else, of the viewer, a reaction without and with the viewer',
      should: 'keep mentions in accent ink, tint the viewer’s, and tint the viewer’s reaction chip',
      actual: [mentionClass(false), mentionClass(true), reactionClass(false), reactionClass(true)],
      expected: [
        'font-medium text-accent',
        'rounded-sm bg-accent-soft px-1 font-medium text-accent',
        'inline-flex items-center gap-1 rounded-round border px-2 text-xs border-hairline text-ink-muted',
        'inline-flex items-center gap-1 rounded-round border px-2 text-xs border-accent bg-accent-soft text-ink',
      ],
    });
  });
});

describe('dividerLineClass()', () => {
  test('unread turns the line accent', () => {
    assert({
      given: 'a read divider and an unread one',
      should: 'be a hairline, or an accent line where unread begins',
      actual: [dividerLineClass(false), dividerLineClass(true)],
      expected: ['h-px flex-1 bg-hairline', 'h-px flex-1 bg-accent'],
    });
  });
});

describe('thread parts', () => {
  test('exact classes', () => {
    assert({
      given: 'the thread’s fixed parts',
      should: 'be these exact classes',
      actual: [
        threadClass,
        threadTitleClass,
        threadNoteClass,
        olderClass,
        postAuthorClass,
        postTimeClass,
        postFollowTimeClass,
        postBodyClass,
        editedClass,
        reactionsClass,
        dividerClass,
        dividerLabelClass,
        dividerNewClass,
      ],
      expected: [
        'flex w-full flex-col px-6 py-4',
        'flex items-center gap-2 pb-2 text-md font-semibold text-ink',
        'px-2 py-4 text-sm text-ink-muted',
        'self-center',
        'text-sm font-semibold text-ink',
        'text-xs text-ink-faint tabular-nums',
        'w-avatar-sm flex-none pt-1 text-center text-2xs text-ink-faint tabular-nums opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
        'text-sm leading-normal break-words whitespace-pre-wrap text-ink',
        'text-xs text-ink-faint',
        'mt-1 flex flex-wrap gap-1',
        'my-3 flex items-center gap-3 text-xs font-medium',
        'text-ink-faint',
        'text-accent',
      ],
    });
  });

  test('every class resolves against the theme', async () => {
    const classes = [
      ...[false, true].flatMap((lead) => [false, true].map((mentioned) => postClass({ lead, mentioned, pending: true }))),
      mentionClass(false),
      mentionClass(true),
      reactionClass(false),
      reactionClass(true),
      dividerLineClass(false),
      dividerLineClass(true),
      threadClass,
      threadTitleClass,
      threadNoteClass,
      olderClass,
      postAuthorClass,
      postTimeClass,
      postFollowTimeClass,
      postBodyClass,
      editedClass,
      reactionsClass,
      dividerClass,
      dividerLabelClass,
      dividerNewClass,
    ]
      .flatMap((list) => list.split(' '))
      .filter((cls, index, all) => all.indexOf(cls) === index);
    const css = await compile(classes);
    assert({
      given: `the ${classes.length} classes the thread view emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
