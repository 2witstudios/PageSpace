import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { IconName } from '../../components/icon/icon-names';
import { handoffFor } from './handoff';

const page = (type: string, overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  title: 'Q3 numbers',
  type,
  driveId: 'd1',
  isTrashed: false,
  ...overrides,
});

const handedOff: readonly (readonly [string, IconName])[] = [
  ['Sheet', 'sheet'],
  ['Canvas', 'canvas'],
  ['Code', 'code'],
  ['File', 'file'],
  ['Task List', 'tasks'],
];

describe('handoffFor()', () => {
  test('the page types imago does not open', () => {
    const types = ['SHEET', 'CANVAS', 'CODE', 'FILE', 'TASK_LIST'];
    assert({
      given: 'a sheet, a canvas, a code page, a file and a task list opened in Files',
      should: 'hand each off to classic with its type, glyph, title and the classic page address, and offer no agent',
      actual: types.map((type) => handoffFor(page(type), 'd1', 'p1')),
      expected: handedOff.map(([typeLabel, icon]) => ({
        typeLabel,
        icon,
        title: 'Q3 numbers',
        classicHref: '/dashboard/d1/p1',
        agent: null,
      })),
    });
  });

  test('an agent page', () => {
    assert({
      given: 'an AI chat page',
      should: 'hand it off with the agent to chat with, named as the page is',
      actual: handoffFor(page('AI_CHAT', { title: 'Support' }), 'd1', 'p1'),
      expected: {
        typeLabel: 'AI Chat',
        icon: 'bot',
        title: 'Support',
        classicHref: '/dashboard/d1/p1',
        agent: { id: 'p1', title: 'Support' },
      },
    });
  });

  test('the page types imago draws itself', () => {
    assert({
      given: 'a document, a folder and a channel, and an answer not yet in',
      should: 'not hand off: the page draws its own view',
      actual: [handoffFor(page('DOCUMENT'), 'd1', 'p1'), handoffFor(page('FOLDER'), 'd1', 'p1'), handoffFor(page('CHANNEL'), 'd1', 'p1'), handoffFor(undefined, 'd1', 'p1')],
      expected: [null, null, null, null],
    });
  });

  test('a page with no name', () => {
    assert({
      given: 'a sheet whose title is blank',
      should: 'call it Untitled rather than draw an empty name',
      actual: [handoffFor(page('SHEET', { title: '' }), 'd1', 'p1')?.title, handoffFor(page('AI_CHAT', { title: '  ' }), 'd1', 'p1')?.agent],
      expected: ['Untitled', { id: 'p1', title: 'Untitled' }],
    });
  });

  test('ids that need escaping', () => {
    assert({
      given: 'a drive and page id with characters a path segment cannot hold',
      should: 'escape each into its own segment under /dashboard/',
      actual: handoffFor(page('CODE'), 'a/b', '../x')?.classicHref,
      expected: '/dashboard/a%2Fb/..%2Fx',
    });
  });
});
