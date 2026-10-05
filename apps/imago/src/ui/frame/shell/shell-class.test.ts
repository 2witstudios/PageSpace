import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { paneLayout, stageFor, type ListSection } from '../stage/stage';
import {
  chatSlotClass,
  columnClass,
  listSlotClass,
  objectSlotClass,
  railClass,
  shellClass,
} from './shell-class';

const widths = (pathname: string, collapsedSections: readonly ListSection[] = []): readonly string[] => {
  const layout = paneLayout(stageFor(pathname), { collapsedSections });
  return [listSlotClass(layout), objectSlotClass(layout), chatSlotClass(layout)];
};

describe('shell slot widths', () => {
  test('a drive’s chat', () => {
    assert({
      given: 'the drive chat stage',
      should: 'close the list and the object and give the chat the frame',
      actual: widths('/drive-1'),
      expected: ['w-0', 'w-0', 'w-stage-chat'],
    });
  });

  test('stage 2', () => {
    assert({
      given: 'a section’s list',
      should: 'open the wide list and give the chat the rest',
      actual: [widths('/drive-1/files'), widths('/drive-1/tasks'), widths('/dm')],
      expected: [
        ['w-list-pane', 'w-0', 'w-stage-chat-list'],
        ['w-list-pane', 'w-0', 'w-stage-chat-list'],
        ['w-list-pane', 'w-0', 'w-stage-chat-list'],
      ],
    });
  });

  test('stage 3', () => {
    assert({
      given: 'an open page or conversation',
      should: 'narrow the list to the tree, fill with the object and fix the chat',
      actual: [widths('/drive-1/files/page-1'), widths('/dm/conversation-1')],
      expected: [
        ['w-tree-pane', 'w-stage-object-tree', 'w-chat-pane'],
        ['w-tree-pane', 'w-stage-object-tree', 'w-chat-pane'],
      ],
    });
  });

  test('stage 3 with its list hidden', () => {
    assert({
      given: 'an open page with its section collapsed',
      should: 'close the tree and give the object its room',
      actual: widths('/drive-1/files/page-1', ['files']),
      expected: ['w-0', 'w-stage-object', 'w-chat-pane'],
    });
  });

  test('an object with no list', () => {
    assert({
      given: 'drive settings and the account',
      should: 'open the object beside the fixed chat with no list',
      actual: [widths('/drive-1/settings'), widths('/account')],
      expected: [
        ['w-0', 'w-stage-object', 'w-chat-pane'],
        ['w-0', 'w-stage-object', 'w-chat-pane'],
      ],
    });
  });
});

describe('shell frame classes', () => {
  test('the frame', () => {
    assert({
      given: 'the shell',
      should: 'fill the viewport as one row that never scrolls',
      actual: shellClass,
      expected: 'flex h-screen w-full overflow-hidden',
    });
  });

  test('the rail', () => {
    assert({
      given: 'the rail slot',
      should: 'be the one 64px glass column with a hairline',
      actual: railClass,
      expected:
        'flex h-full w-rail-width flex-none flex-col items-center gap-rail-gap border-r border-hairline py-rail-y surface-glass',
    });
  });

  test('a column', () => {
    assert({
      given: 'the object and chat columns inside their panes',
      should: 'stack the header over a body that scrolls on its own',
      actual: columnClass,
      expected: 'flex h-full w-full min-w-0 flex-col',
    });
  });
});
