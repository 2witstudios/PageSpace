import { describe, it, expect, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { getOutboundMessages } from '../outboundMessages';

const CONV = 'conv-1';
const msg = (id: string, role: 'user' | 'assistant' = 'user', extra: Record<string, unknown> = {}) =>
  ({ id, role, parts: [{ type: 'text', text: id }], ...extra }) as UIMessage;

beforeEach(() => {
  useConversationMessagesStore.setState({ byConversationId: {} });
});

describe('getOutboundMessages', () => {
  it('given no conversation, returns nothing rather than throwing', () => {
    expect(getOutboundMessages(null)).toEqual([]);
  });

  it('given an unknown conversation, returns nothing', () => {
    expect(getOutboundMessages('never-seen')).toEqual([]);
  });

  it('returns DB-confirmed rows followed by this tab\'s optimistic sends', () => {
    // The order matters: the newest message must be last, because both routes read the request
    // array only for its final entry.
    conversationMessagesActions.seedConversation(CONV);
    conversationMessagesActions.applyConfirmedMessage(CONV, msg('m-1'));
    conversationMessagesActions.applyConfirmedMessage(CONV, msg('m-2', 'assistant'));
    conversationMessagesActions.addOptimisticSend(CONV, msg('m-3'));

    expect(getOutboundMessages(CONV).map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3']);
  });

  it('EXCLUDES a half-written streaming placeholder', () => {
    // Loads carry includeStreaming=1 so a history rejoin can see an in-flight reply, so the
    // cache legitimately holds these. Sending one as history hands the model a truncated
    // assistant turn — and because `askUserAnswersComplete` inspects the LAST message, a
    // trailing placeholder silently suppresses the auto-resume after an ask_user answer.
    conversationMessagesActions.seedConversation(CONV);
    conversationMessagesActions.applyConfirmedMessage(CONV, msg('m-1'));
    conversationMessagesActions.applyConfirmedMessage(
      CONV,
      msg('m-live', 'assistant', { status: 'streaming' }),
    );

    expect(getOutboundMessages(CONV).map((m) => m.id)).toEqual(['m-1']);
  });

  it('KEEPS a terminal interrupted row — it is real partial output, not a placeholder', () => {
    conversationMessagesActions.seedConversation(CONV);
    conversationMessagesActions.applyConfirmedMessage(
      CONV,
      msg('m-stopped', 'assistant', { status: 'interrupted' }),
    );

    expect(getOutboundMessages(CONV).map((m) => m.id)).toEqual(['m-stopped']);
  });

  it('is keyed by conversation — one conversation never leaks into another', () => {
    // The whole reason this takes an id instead of closing over one. A surface serving two
    // conversations must get each one's own history.
    conversationMessagesActions.seedConversation('conv-A');
    conversationMessagesActions.applyConfirmedMessage('conv-A', msg('a-1'));
    conversationMessagesActions.seedConversation('conv-B');
    conversationMessagesActions.applyConfirmedMessage('conv-B', msg('b-1'));

    expect(getOutboundMessages('conv-A').map((m) => m.id)).toEqual(['a-1']);
    expect(getOutboundMessages('conv-B').map((m) => m.id)).toEqual(['b-1']);
  });
});
