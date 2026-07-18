import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import type { RenderedMessage } from '../selectRenderedMessages';
import { selectVoiceActivationBaseline } from '../selectVoiceActivationBaseline';

const msg = (id: string, role: UIMessage['role']): UIMessage => ({ id, role, parts: [] });
const confirmed = (id: string, role: UIMessage['role']): RenderedMessage => ({ message: msg(id, role), mode: 'confirmed' });
const streaming = (id: string): RenderedMessage => ({ message: msg(id, 'assistant'), mode: 'streaming' });

describe('selectVoiceActivationBaseline', () => {
  it('given a stream is mid-flight when voice activates, should baseline to the PREVIOUSLY-finalized assistant message, not the in-progress one', () => {
    const rendered = [
      confirmed('u1', 'user'),
      confirmed('a1', 'assistant'),
      confirmed('u2', 'user'),
      streaming('a2'),
    ];
    expect(selectVoiceActivationBaseline(rendered)).toBe('a1');
  });

  it('given nothing is streaming, should baseline to the LAST assistant message (nothing new speaks until a future reply)', () => {
    const rendered = [confirmed('u1', 'user'), confirmed('a1', 'assistant')];
    expect(selectVoiceActivationBaseline(rendered)).toBe('a1');
  });

  it('given no assistant messages exist yet, should baseline to null', () => {
    const rendered = [confirmed('u1', 'user')];
    expect(selectVoiceActivationBaseline(rendered)).toBeNull();
  });

  it('given a stream is mid-flight with no prior assistant message, should baseline to null', () => {
    const rendered = [confirmed('u1', 'user'), streaming('a1')];
    expect(selectVoiceActivationBaseline(rendered)).toBeNull();
  });

  it('given an empty rendered list, should baseline to null', () => {
    expect(selectVoiceActivationBaseline([])).toBeNull();
  });
});
