import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from '../store/state';
import { transactions } from '../store/transactions';
import { chatPlugin, isStreaming, shownConversationId } from './chat-plugin';

const { startStreaming, endStreaming, setChatDraft, openConversation, startNewChat, selectAgent, loseAgent } = chatPlugin.transactions;

describe('chatPlugin', () => {
  test('nothing streaming', () => {
    assert({
      given: 'a fresh UI state',
      should: 'stream nothing',
      actual: [createInitialState().resources.streaming, isStreaming(createInitialState(), 'c1')],
      expected: [null, false],
    });
  });

  test('resources', () => {
    const first = chatPlugin.resources();
    assert({
      given: 'the chat slice’s resources, built twice, and a fresh UI state',
      should: 'stream nothing, draft nothing, open no conversation and no new chat, fresh each time and composed into the initial state',
      actual: [
        first,
        first === chatPlugin.resources(),
        [
          createInitialState().resources.streaming,
          createInitialState().resources.chatDraft,
          createInitialState().resources.chatConversationId,
          createInitialState().resources.chatNew,
        ],
      ],
      expected: [
        { streaming: null, chatDraft: '', chatConversationId: null, chatAgent: null, chatAgentLost: null, chatNew: false },
        false,
        [null, '', null, false],
      ],
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

  test('setChatDraft', () => {
    const typed = setChatDraft(createInitialState(), 'Summarise the roadmap');
    assert({
      given: 'a fresh state, then a typed draft, then the same draft again',
      should: 'start empty, keep what was typed in shell state, and return the same snapshot for no change',
      actual: [createInitialState().resources.chatDraft, typed.resources.chatDraft, setChatDraft(typed, 'Summarise the roadmap') === typed],
      expected: ['', 'Summarise the roadmap', true],
    });
  });

  test('openConversation', () => {
    const opened = openConversation(createInitialState(), 'c2');
    assert({
      given: 'a fresh state, then a conversation opened, then the same one again',
      should: 'name no conversation at first, then the opened one, and change nothing on a repeat',
      actual: [createInitialState().resources.chatConversationId, opened.resources.chatConversationId, openConversation(opened, 'c2') === opened],
      expected: [null, 'c2', true],
    });
  });

  test('startNewChat', () => {
    const opened = openConversation(createInitialState(), 'c2');
    const fresh = startNewChat(setChatDraft(opened, 'half a thought'));
    assert({
      given: 'a conversation open with a draft, then New chat, then New chat again',
      should: 'open an empty thread with no conversation, keep the draft, and change nothing on a repeat',
      actual: [
        fresh.resources.chatNew,
        fresh.resources.chatConversationId,
        fresh.resources.chatDraft,
        startNewChat(fresh) === fresh,
      ],
      expected: [true, null, 'half a thought', true],
    });
  });

  test('openConversation after New chat', () => {
    const opened = openConversation(startNewChat(createInitialState()), 'c3');
    assert({
      given: 'New chat, then a conversation opened (picked, or created by the first send)',
      should: 'leave the new chat for that conversation',
      actual: [opened.resources.chatNew, opened.resources.chatConversationId],
      expected: [false, 'c3'],
    });
  });

  test('shownConversationId', () => {
    const initial = createInitialState().resources;
    const opened = openConversation(createInitialState(), 'c2').resources;
    const fresh = startNewChat(createInitialState()).resources;
    assert({
      given: 'nothing chosen, a chosen conversation and New chat, each with the agent’s latest conversation c1',
      should: 'show the latest, the chosen one, and none',
      actual: [shownConversationId(initial, 'c1'), shownConversationId(opened, 'c1'), shownConversationId(fresh, 'c1'), shownConversationId(initial, null)],
      expected: ['c1', 'c2', null, null],
    });
  });

  test('draft and conversation registered', () => {
    assert({
      given: 'the shell transactions',
      should: 'include the draft, conversation and new chat transactions',
      actual: [
        transactions.setChatDraft === setChatDraft,
        transactions.openConversation === openConversation,
        transactions.startNewChat === startNewChat,
      ],
      expected: [true, true, true],
    });
  });
});

describe('the chat agent', () => {
  const planner = { id: 'p-planner', title: 'Planner' };
  const support = { id: 'a1', title: 'Support' };

  test('selectAgent', () => {
    const drafted = openConversation(setChatDraft(createInitialState(), 'Half a thought'), 'c1');
    const switched = selectAgent(drafted, support);
    const back = selectAgent(switched, null);
    assert({
      given: 'a draft and an open conversation with Imago, then another agent chosen, then Imago again, then the same agent twice',
      should: 'bind the chosen agent and drop the open conversation so its latest one opens, keep the draft, and change nothing on a repeat',
      actual: [
        [switched.resources.chatAgent, switched.resources.chatConversationId, switched.resources.chatDraft],
        [back.resources.chatAgent, back.resources.chatConversationId],
        selectAgent(switched, { ...support }) === switched,
        selectAgent(drafted, null) === drafted,
      ],
      expected: [[support, null, 'Half a thought'], [null, null], true, true],
    });
  });

  test('loseAgent', () => {
    const chosen = openConversation(selectAgent(createInitialState(), planner), 'c9');
    const lost = loseAgent(chosen, 'p-planner');
    assert({
      given: 'the planner chosen with a conversation open, then the viewer losing access to it, or to some other agent',
      should: 'fall back to Imago with no conversation open and remember which agent was lost, leaving the state alone for any other agent',
      actual: [
        [lost.resources.chatAgent, lost.resources.chatConversationId, lost.resources.chatAgentLost],
        loseAgent(chosen, 'a-other') === chosen,
        loseAgent(createInitialState(), 'p-planner').resources.chatAgentLost,
        selectAgent(lost, support).resources.chatAgentLost,
        selectAgent(lost, null).resources.chatAgentLost,
      ],
      expected: [[null, null, 'Planner'], true, null, null, null],
    });
  });

  test('a new chat follows the agent', () => {
    const fresh = startNewChat(selectAgent(createInitialState(), planner));
    const switched = selectAgent(fresh, support);
    const lost = loseAgent(fresh, 'p-planner');
    assert({
      given: 'New chat open with Planner, then another agent chosen, or Planner refused',
      should: 'leave the new chat for the next agent’s latest conversation either way',
      actual: [
        [switched.resources.chatNew, switched.resources.chatAgent?.id, shownConversationId(switched.resources, 'c-support')],
        [lost.resources.chatNew, lost.resources.chatAgent, shownConversationId(lost.resources, 'c-imago')],
      ],
      expected: [
        [false, 'a1', 'c-support'],
        [false, null, 'c-imago'],
      ],
    });
  });

  test('registered', () => {
    assert({
      given: 'the shell transactions',
      should: 'include the agent transactions',
      actual: [transactions.selectAgent === selectAgent, transactions.loseAgent === loseAgent],
      expected: [true, true],
    });
  });
});

describe('chatPlugin slice', () => {
  test('its own resources and transactions', () => {
    assert({
      given: 'the chat slice',
      should: 'start with nothing streaming, no draft, no conversation, Imago and no new chat, and own the streaming, draft, conversation, agent and new chat transactions',
      actual: [chatPlugin.resources(), Object.keys(chatPlugin.transactions).sort()],
      expected: [
        { streaming: null, chatDraft: '', chatConversationId: null, chatAgent: null, chatAgentLost: null, chatNew: false },
        ['endStreaming', 'loseAgent', 'openConversation', 'selectAgent', 'setChatDraft', 'startNewChat', 'startStreaming'],
      ],
    });
  });
});
