import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

/**
 * `initial` and `resize` deliberately differ, and the asymmetry is easy to
 * "harmonize" away by someone who reads them as one setting. This pins both.
 *
 * `initial` fires exactly once per mounted content element — the content going
 * 0 -> full height when a conversation opens. Animating that scrolls the entire
 * thread past the user, on every open and every conversation switch (ChatLayout
 * keys the messages panel by conversationId, so switching remounts it).
 *
 * `resize` fires on every subsequent growth, i.e. normal token streaming, where
 * following the stream should read as motion rather than a snap. It must stay
 * smooth: use-stick-to-bottom 1.1.4 routes all post-initial content growth
 * through this one path, so making it instant would trade away stream following
 * to fix nothing.
 */

const capturedProps: Record<string, unknown>[] = [];

vi.mock('use-stick-to-bottom', () => ({
  StickToBottom: Object.assign(
    (props: Record<string, unknown>) => {
      capturedProps.push(props);
      return React.createElement('div', { 'data-testid': 'stick-to-bottom' });
    },
    { Content: (props: Record<string, unknown>) => React.createElement('div', props) }
  ),
  useStickToBottomContext: () => ({ isAtBottom: true, scrollToBottom: vi.fn(), scrollRef: { current: null } }),
}));

const { Conversation } = await import('../conversation');

describe('Conversation scroll behaviour', () => {
  it('given a freshly mounted conversation, should land at the bottom instantly rather than animating down the thread', () => {
    capturedProps.length = 0;
    render(<Conversation><span /></Conversation>);

    expect(capturedProps[0]?.initial).toBe('instant');
  });

  it('given content growing after mount, should follow smoothly', () => {
    capturedProps.length = 0;
    render(<Conversation><span /></Conversation>);

    expect(capturedProps[0]?.resize).toBe('smooth');
  });

  it('given a caller that overrides them, should let the call site win', () => {
    capturedProps.length = 0;
    render(
      <Conversation initial="smooth" resize="instant">
        <span />
      </Conversation>
    );

    expect(capturedProps[0]?.initial).toBe('smooth');
    expect(capturedProps[0]?.resize).toBe('instant');
  });
});
