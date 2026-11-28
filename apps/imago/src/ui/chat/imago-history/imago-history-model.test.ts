import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { agentConversation } from '../chat-model/fixtures';
import { matchingConversations, streamingConversationIds } from './imago-history-model';

describe('streamingConversationIds() (IMC-2.7)', () => {
  test('the viewer’s live streams', () => {
    assert({
      given: 'active-streams scope=user with two live streams and a junk row',
      should: 'name the conversations still generating',
      actual: [...streamingConversationIds({ streams: [{ conversationId: 'c1' }, { conversationId: 'c2' }, { nope: 1 }] })],
      expected: ['c1', 'c2'],
    });
  });

  test('nothing loaded', () => {
    assert({ given: 'no body', should: 'name none', actual: streamingConversationIds(undefined).size, expected: 0 });
  });
});

describe('matchingConversations()', () => {
  test('client-side search over loaded conversations', () => {
    const list = [agentConversation('a', { title: 'Risks section for Q4 Launch Plan' }), agentConversation('b', { title: 'Pricing FAQ edits' })];
    assert({
      given: '"pricing" typed, and an empty query',
      should: 'keep the matching titles, case-insensitively, and every row for no query',
      actual: [matchingConversations(list, 'pricing').map((c) => c.id), matchingConversations(list, '  ').length],
      expected: [['b'], 2],
    });
  });
});
