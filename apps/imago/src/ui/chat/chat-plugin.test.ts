import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from '../store/state';
import { transactions } from '../store/transactions';
import { chatPlugin, isStreaming } from './chat-plugin';

const { startStreaming, endStreaming } = chatPlugin.transactions;

describe('chatPlugin', () => {
  test('nothing streaming', () => {
    assert({
      given: 'a fresh UI state',
      should: 'stream nothing',
      actual: [createInitialState().resources.streaming, isStreaming(createInitialState(), 'c1')],
      expected: [null, false],
    });
  });

  test('startStreaming', () => {
    const streaming = startStreaming(createInitialState(), 'c1');
    assert({
      given: 'a turn starting in a conversation',
      should: 'set the streaming resource to that conversation only, leaving the rest alone',
      actual: [
        streaming.resources.streaming,
        isStreaming(streaming, 'c1'),
        isStreaming(streaming, 'c2'),
        streaming.resources.taskView,
        startStreaming(streaming, 'c1') === streaming,
      ],
      expected: [{ conversationId: 'c1' }, true, false, 'tree', true],
    });
  });

  test('endStreaming', () => {
    const streaming = startStreaming(createInitialState(), 'c1');
    assert({
      given: 'the turn ending, or another conversation ending',
      should: 'clear the resource only for the conversation that was streaming',
      actual: [endStreaming(streaming, 'c1').resources.streaming, endStreaming(streaming, 'c2') === streaming],
      expected: [null, true],
    });
  });

  test('registered', () => {
    assert({
      given: 'the shell transactions',
      should: 'include the chat section\'s',
      actual: [transactions.startStreaming === startStreaming, transactions.endStreaming === endStreaming],
      expected: [true, true],
    });
  });
});
