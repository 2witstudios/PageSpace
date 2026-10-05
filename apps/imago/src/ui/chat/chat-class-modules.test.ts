import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  chatAgentNameClass,
  chatContextLabelClass,
  chatEmptyClass,
  chatHeaderTitleClass,
  chatNoticeClass,
  chatPaneClass,
  chatScrollClass,
  chatThreadClass,
} from './chat-pane/chat-pane-class';
import { chatMessageClass } from './chat-message/chat-message-class';
import { citationChipClass } from './citation-chip/citation-chip-class';
import {
  composerActionsClass,
  composerEntryClass,
  composerFieldClass,
  composerFormClass,
  composerSendClass,
  composerShellClass,
} from './composer/composer-class';
import { proseClasses } from './chat-prose/chat-prose-class';
import {
  toolDetailClass,
  toolStateClass,
  toolSummaryClass,
  toolSummaryLineClass,
  toolTargetClass,
} from './tool-summary/tool-summary-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../app');
const appRoot = join(appDir, '..', '..');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: appRoot }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.chat.css'),
  });
  return result.css;
};

/** A class's selector as Tailwind escapes it; variants only prefix it, so the base name is what is searched. */
const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

describe('chat message classes', () => {
  test('exact strings', () => {
    assert({
      given: 'a user message and an assistant reply, roomy and dense',
      should: 'make the user an accent-soft card and the assistant plain prose with no fill (ADR 0029 decision 6)',
      actual: [
        chatMessageClass('user', 'roomy'),
        chatMessageClass('user', 'dense'),
        chatMessageClass('assistant', 'roomy'),
        chatMessageClass('assistant', 'dense'),
      ],
      expected: [
        'flex min-w-0 flex-col gap-2 leading-normal text-ink text-base ml-8 rounded-lg bg-accent-soft p-3',
        'flex min-w-0 flex-col gap-2 leading-normal text-ink text-sm ml-4 rounded-lg bg-accent-soft px-3 py-2',
        'flex min-w-0 flex-col gap-2 leading-normal text-ink text-base mr-8',
        'flex min-w-0 flex-col gap-2 leading-normal text-ink text-sm mr-4',
      ],
    });
  });

  test('no bubble behind a reply', () => {
    const assistant = ['roomy', 'dense'].flatMap((density) =>
      chatMessageClass('assistant', density as 'roomy' | 'dense').split(' '),
    );
    assert({
      given: 'every assistant message class',
      should: 'carry no fill, border or radius',
      actual: assistant.filter((cls) => /^(bg-|border|rounded|shadow)/.test(cls)),
      expected: [],
    });
  });
});

describe('composer classes', () => {
  test('exact strings', () => {
    assert({
      given: 'the composer form, column, entry card, field, actions and send control',
      should: 'float a rounded-composer card with no strip above it, centred while roomy',
      actual: [
        composerFormClass,
        composerShellClass('roomy'),
        composerShellClass('dense'),
        composerEntryClass,
        composerFieldClass('roomy'),
        composerFieldClass('dense'),
        composerActionsClass,
        composerSendClass,
      ],
      expected: [
        'flex-none pt-2 pb-4',
        'mx-auto w-full max-w-thread px-6',
        'w-full px-4',
        'flex flex-col gap-2 rounded-composer border border-border/60 bg-background p-3 shadow-ambient transition-colors duration-120 ease-standard focus-within:border-border-strong',
        'w-full resize-none border-none bg-transparent text-ink outline-none placeholder:text-ink-faint h-composer-field text-base',
        'w-full resize-none border-none bg-transparent text-ink outline-none placeholder:text-ink-faint h-composer-field-dense text-sm',
        'flex items-center justify-end gap-1',
        'flex size-send flex-none cursor-pointer items-center justify-center rounded-round bg-send text-send-ink transition-colors duration-120 ease-standard disabled:cursor-default disabled:opacity-50',
      ],
    });
  });
});

describe('citation chip class', () => {
  test('exact string', () => {
    assert({
      given: 'a citation chip',
      should: 'be a hairline rounded-md chip in xs medium ink',
      actual: citationChipClass,
      expected:
        'mx-1 inline-flex items-center gap-1 rounded-md border border-hairline px-2 align-baseline text-xs font-medium text-ink-muted no-underline hover:border-border-strong hover:text-ink',
    });
  });
});

describe('tool summary classes', () => {
  test('exact strings', () => {
    assert({
      given: 'the tool call disclosure, its one line, target, states and detail',
      should: 'be one compact muted line that expands to a sunken detail',
      actual: [
        toolSummaryClass,
        toolSummaryLineClass,
        toolTargetClass,
        toolStateClass('running'),
        toolStateClass('done'),
        toolStateClass('failed'),
        toolStateClass('denied'),
        toolDetailClass,
      ],
      expected: [
        'group min-w-0 text-xs text-ink-muted',
        'flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-overlay hover:text-ink',
        'min-w-0 flex-1 truncate text-ink-faint',
        'flex-none text-accent',
        'flex-none text-ink-faint',
        'flex-none text-warn',
        'flex-none text-ink-faint',
        'mt-1 ml-6 overflow-x-auto rounded-md bg-surface-sunken p-2 font-mono text-2xs whitespace-pre-wrap text-ink-muted',
      ],
    });
  });
});

describe('chat pane classes', () => {
  test('exact strings', () => {
    assert({
      given: 'the pane and thread, roomy and dense, and the header, scroller, empty and notice text',
      should: 'centre a roomy thread at the thread width and pack a dense one beside the object',
      actual: [
        chatPaneClass('roomy'),
        chatPaneClass('dense'),
        chatThreadClass('roomy'),
        chatThreadClass('dense'),
        chatScrollClass,
        chatHeaderTitleClass,
        chatAgentNameClass,
        chatContextLabelClass,
        chatEmptyClass,
        chatNoticeClass,
      ],
      expected: [
        'flex h-full w-full min-w-0 flex-col',
        'flex h-full w-full min-w-0 flex-col border-l border-hairline',
        'mx-auto flex w-full max-w-thread flex-col gap-4 px-6 py-8',
        'flex w-full flex-col gap-3 p-4',
        'min-h-0 flex-1 overflow-y-auto',
        'flex min-w-0 items-center gap-2',
        'flex-none font-medium',
        'truncate text-xs font-normal text-ink-muted',
        'my-auto text-center text-ink-faint',
        'text-sm text-warn',
      ],
    });
  });
});

const moduleClasses = [
  ...(['user', 'assistant'] as const).flatMap((author) =>
    (['roomy', 'dense'] as const).map((density) => chatMessageClass(author, density)),
  ),
  composerFormClass,
  composerShellClass('roomy'),
  composerShellClass('dense'),
  composerEntryClass,
  composerFieldClass('roomy'),
  composerFieldClass('dense'),
  composerActionsClass,
  composerSendClass,
  citationChipClass,
  toolSummaryClass,
  toolSummaryLineClass,
  toolTargetClass,
  ...(['running', 'done', 'failed', 'denied'] as const).map(toolStateClass),
  toolDetailClass,
  chatPaneClass('roomy'),
  chatPaneClass('dense'),
  chatThreadClass('roomy'),
  chatThreadClass('dense'),
  chatScrollClass,
  chatHeaderTitleClass,
  chatAgentNameClass,
  chatContextLabelClass,
  chatEmptyClass,
  chatNoticeClass,
  ...Object.values(proseClasses),
]
  .flatMap((list) => list.split(' '))
  .filter((cls, index, all) => all.indexOf(cls) === index);

describe('chat class modules against the theme', () => {
  test('every class resolves', async () => {
    const css = await compile(moduleClasses);
    assert({
      given: `the ${moduleClasses.length} classes the chat modules emit`,
      should: 'each generate a rule from the token-locked theme',
      actual: moduleClasses.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });

  test('the composer radius and thread width', async () => {
    const css = await compile(['rounded-composer', 'max-w-thread']);
    assert({
      given: 'the composer card and the roomy thread column',
      should: 'round at the 16px composer token and cap at the 56rem thread token',
      actual: [
        /--radius-composer: 16px/.test(css) && /\.rounded-composer \{\s*border-radius: var\(--radius-composer\)/.test(css),
        /--container-thread: 56rem/.test(css) && /\.max-w-thread \{\s*max-width: var\(--container-thread\)/.test(css),
      ],
      expected: [true, true],
    });
  });
});
