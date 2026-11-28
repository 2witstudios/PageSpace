import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { ChatMessage } from '../chat-model/chat';
import { assistantWithTool, userMessage } from '../chat-model/fixtures';
import { citationHref, citationMarkdown, citedPageId, messageBlocks } from './chat-text';

describe('messageBlocks()', () => {
  test('text and tools in order', () => {
    assert({
      given: 'an assistant turn with a step marker, a tool call and its text',
      should: 'skip the step marker and keep the tool call and the text in the order they came',
      actual: messageBlocks(assistantWithTool('m2').parts).map((block) =>
        block.kind === 'text' ? `text:${block.text}` : `tool:${block.tool.name}:${block.tool.state}`,
      ),
      expected: ['tool:Read page:done', 'text:The roadmap says ship in October.'],
    });
  });

  test('consecutive text parts', () => {
    const parts: ChatMessage['parts'] = [
      { type: 'text', text: 'Ship ' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'in October.' },
      { type: 'dynamic-tool', toolName: 'list_pages', toolCallId: 'call-2', state: 'input-available', input: {} },
      { type: 'text', text: 'Done.' },
    ];
    assert({
      given: 'text split by a reasoning part, then a dynamic tool and more text',
      should: 'join the text the reasoning split, and break the text at the tool',
      actual: messageBlocks(parts).map((block) => (block.kind === 'text' ? block.text : block.tool.name)),
      expected: ['Ship in October.', 'List pages', 'Done.'],
    });
  });

  test('a user message', () => {
    assert({
      given: 'a user message with one text part',
      should: 'be one text block',
      actual: messageBlocks(userMessage('m1', 'Hi').parts),
      expected: [{ kind: 'text', text: 'Hi' }],
    });
  });

  test('no text', () => {
    assert({
      given: 'a reply that has not written anything yet',
      should: 'have no blocks',
      actual: messageBlocks([{ type: 'step-start' }, { type: 'text', text: '' }]),
      expected: [],
    });
  });
});

describe('citationMarkdown()', () => {
  test('page mentions', () => {
    assert({
      given: 'a reply citing a page with the @[label](id:page) mention classic writes',
      should: 'turn the mention into a citation link the prose renders as a chip',
      actual: citationMarkdown('See @[Roadmap](p1:page) for dates.'),
      expected: 'See [Roadmap](/__cite/p1) for dates.',
    });
  });

  test('other mentions and malformed ids', () => {
    assert({
      given: 'a user mention, @everyone, and a page mention whose id is not an id',
      should: 'keep them as plain @names and link nothing',
      actual: citationMarkdown('@[Ada](u1:user) @[everyone](d1:everyone) @[Evil](../x:page)'),
      expected: '@Ada @everyone @Evil',
    });
  });
});

describe('citedPageId()', () => {
  test('citation links only', () => {
    assert({
      given: 'a citation link, an ordinary link, a nested path and nothing',
      should: 'answer the cited page id only for the citation link',
      actual: [citedPageId('/__cite/p1'), citedPageId('https://example.com'), citedPageId('/__cite/p1/x'), citedPageId(undefined)],
      expected: ['p1', null, null, null],
    });
  });
});

describe('citationHref()', () => {
  test('the page in the files section', () => {
    assert({
      given: 'a drive id and a page id',
      should: 'resolve the cited page by its actual authorized drive (basePath adds /imago)',
      actual: citationHref('d 1', 'p1'),
      expected: '/p/p1',
    });
  });
});
