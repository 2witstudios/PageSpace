import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { getAssistantMessagesAfterLastUser } from '../getAssistantMessagesAfterLastUser';

const msg = (id: string, role: UIMessage['role']): UIMessage => ({ id, role, parts: [] });

describe('getAssistantMessagesAfterLastUser', () => {
  it('given no user message at all, returns an empty array', () => {
    const messages = [msg('a1', 'assistant'), msg('a2', 'assistant')];
    expect(getAssistantMessagesAfterLastUser(messages)).toEqual([]);
  });

  it('given a single assistant reply after the last user message, returns it', () => {
    const messages = [msg('u1', 'user'), msg('a1', 'assistant')];
    expect(getAssistantMessagesAfterLastUser(messages)).toEqual([msg('a1', 'assistant')]);
  });

  it('given multiple assistant replies after the last user message, returns all of them', () => {
    const messages = [msg('u1', 'user'), msg('a1', 'assistant'), msg('a2', 'assistant')];
    expect(getAssistantMessagesAfterLastUser(messages)).toEqual([
      msg('a1', 'assistant'),
      msg('a2', 'assistant'),
    ]);
  });

  it('given the last user message has no reply yet, returns an empty array', () => {
    const messages = [msg('a1', 'assistant'), msg('u1', 'user')];
    expect(getAssistantMessagesAfterLastUser(messages)).toEqual([]);
  });

  it('given multiple user turns, only considers messages after the LAST user message', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant'),
      msg('u2', 'user'),
      msg('a2', 'assistant'),
    ];
    expect(getAssistantMessagesAfterLastUser(messages)).toEqual([msg('a2', 'assistant')]);
  });

  it('given a non-assistant message after the last user message, excludes it', () => {
    const messages = [msg('u1', 'user'), msg('s1', 'system'), msg('a1', 'assistant')];
    expect(getAssistantMessagesAfterLastUser(messages)).toEqual([msg('a1', 'assistant')]);
  });

  it('given an empty array, returns an empty array', () => {
    expect(getAssistantMessagesAfterLastUser([])).toEqual([]);
  });
});
