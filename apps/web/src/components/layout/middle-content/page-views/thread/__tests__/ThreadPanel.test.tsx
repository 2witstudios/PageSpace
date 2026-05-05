import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('motion/react', () => {
  const passthrough = (Tag: keyof React.JSX.IntrinsicElements) => {
    const C = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
      ({ children, ...props }, ref) =>
        React.createElement(
          Tag,
          {
            ...Object.fromEntries(
              Object.entries(props).filter(
                ([k]) =>
                  !k.startsWith('initial') &&
                  !k.startsWith('animate') &&
                  !k.startsWith('exit') &&
                  !k.startsWith('whileTap') &&
                  !k.startsWith('whileHover') &&
                  !k.startsWith('transition') &&
                  !k.startsWith('layout'),
              ),
            ),
            ref,
          },
          children,
        ),
    );
    C.displayName = `motion.${String(Tag)}`;
    return C;
  };
  return {
    motion: new Proxy(
      {},
      {
        get: (_t, prop: string) => passthrough(prop as keyof React.JSX.IntrinsicElements),
      },
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
  };
});

vi.mock('@/components/ai/chat/input/ChatTextarea', () => {
  interface MockProps {
    value: string;
    onChange: (v: string) => void;
    onSend: () => void;
    placeholder?: string;
    canSendEmpty?: boolean;
    disabled?: boolean;
  }
  const MockChatTextarea = React.forwardRef<
    { focus: () => void; clear: () => void },
    MockProps
  >((props, ref) => {
    React.useImperativeHandle(ref, () => ({ focus: vi.fn(), clear: vi.fn() }));
    return (
      <textarea
        data-testid="chat-textarea"
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if ((props.value.trim() || props.canSendEmpty) && !props.disabled) {
              props.onSend();
            }
          }
        }}
      />
    );
  });
  MockChatTextarea.displayName = 'MockChatTextarea';
  return { ChatTextarea: MockChatTextarea };
});

vi.mock('@/hooks/useAttachmentUpload', () => ({
  useAttachmentUpload: () => ({
    attachment: null,
    isUploading: false,
    uploadFile: vi.fn(),
    clearAttachment: vi.fn(),
  }),
}));

const postSpy = vi.fn<(url: string, body: unknown) => Promise<unknown>>(async () => ({ ok: true }));
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  post: (url: string, body: unknown) => postSpy(url, body),
}));

const mockSocketHandlers = new Map<string, (payload: unknown) => void>();
const mockSocket = {
  on: vi.fn((event: string, handler: (p: unknown) => void) => {
    mockSocketHandlers.set(event, handler);
  }),
  off: vi.fn((event: string) => {
    mockSocketHandlers.delete(event);
  }),
};

vi.mock('@/stores/useSocketStore', () => ({
  useSocketStore: (selector: (s: { socket: typeof mockSocket; connectionStatus: string }) => unknown) =>
    selector({ socket: mockSocket, connectionStatus: 'connected' }),
}));

import { ThreadPanel, type ThreadAuthor } from '../ThreadPanel';
import { useEditingStore } from '@/stores/useEditingStore';
import { SWRConfig } from 'swr';

const FreshCache = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

const baseAuthor = (id: string | null | undefined): ThreadAuthor => ({
  name: id === 'u-self' ? 'Me' : id === 'u-other' ? 'Other' : 'Unknown',
  image: null,
});

const renderPanel = (overrides: Partial<React.ComponentProps<typeof ThreadPanel>> = {}) => {
  const onClose = vi.fn();
  const fetcher =
    overrides.fetcher ??
    vi.fn(async () => ({
      messages: [
        {
          id: 'r1',
          content: 'first reply',
          createdAt: new Date('2026-05-05T12:00:00Z').toISOString(),
          userId: 'u-other',
          parentId: 'p1',
        },
      ],
      hasMore: false,
      nextCursor: null,
    }));
  const utils = render(
    <FreshCache>
      <ThreadPanel
        source="channel"
        contextId="page-1"
        parentId="p1"
        currentUserId="u-self"
        parentSlot={<div data-testid="parent-slot">Parent message</div>}
        resolveAuthor={baseAuthor}
        onClose={onClose}
        fetcher={fetcher}
        {...overrides}
      />
    </FreshCache>,
  );
  return { ...utils, onClose, fetcher };
};

describe('ThreadPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocketHandlers.clear();
    useEditingStore.setState({ activeSessions: new Map(), pendingSends: new Set() });
  });

  it('given an opened channel thread, should render the parent slot and the divider count', async () => {
    renderPanel();

    await waitFor(() => expect(screen.getByTestId('parent-slot')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('thread-divider-count').textContent).toContain('1 reply'));

    expect({
      given: 'an opened channel thread with one reply',
      should: 'show parent slot + divider count',
      actual: !!screen.getByTestId('parent-slot') && !!screen.getByTestId('thread-divider-count'),
      expected: true,
    }).toEqual({
      given: 'an opened channel thread with one reply',
      should: 'show parent slot + divider count',
      actual: true,
      expected: true,
    });
  });

  it('given a draft typed into the composer, should register an editing session keyed by thread:source:contextId:parentId', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('chat-textarea')).toBeInTheDocument());

    await user.type(screen.getByTestId('chat-textarea'), 'draft text');

    await waitFor(() => {
      const sessions = useEditingStore.getState().getActiveSessions();
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain('thread:channel:page-1:p1');
    });

    const sessions = useEditingStore.getState().getActiveSessions();
    const found = sessions.find((s) => s.id === 'thread:channel:page-1:p1');

    expect({
      given: 'a draft typed in the thread composer',
      should: 'register an editing session with the thread session key',
      actual: Boolean(found),
      expected: true,
    }).toEqual({
      given: 'a draft typed in the thread composer',
      should: 'register an editing session with the thread session key',
      actual: true,
      expected: true,
    });
  });

  it('given the also-send checkbox is checked, should POST with alsoSendToParent=true', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('chat-textarea')).toBeInTheDocument());

    await user.click(screen.getByTestId('also-send-to-parent'));
    await user.type(screen.getByTestId('chat-textarea'), 'mirror reply{enter}');

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const [url, body] = postSpy.mock.calls[0];

    expect({
      given: 'reply sent with also-send checked',
      should: 'POST to the channel endpoint with parentId and alsoSendToParent=true',
      actual: { url, body },
      expected: {
        url: '/api/channels/page-1/messages',
        body: { content: 'mirror reply', parentId: 'p1', alsoSendToParent: true },
      },
    }).toEqual({
      given: 'reply sent with also-send checked',
      should: 'POST to the channel endpoint with parentId and alsoSendToParent=true',
      actual: {
        url: '/api/channels/page-1/messages',
        body: { content: 'mirror reply', parentId: 'p1', alsoSendToParent: true },
      },
      expected: {
        url: '/api/channels/page-1/messages',
        body: { content: 'mirror reply', parentId: 'p1', alsoSendToParent: true },
      },
    });
  });

  it('given a realtime new_message arrives with matching parentId, should append it to the reply list', async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getAllByTestId('thread-reply').length).toBeGreaterThanOrEqual(1),
    );

    const handler = mockSocketHandlers.get('new_message');
    expect(typeof handler).toBe('function');

    act(() => {
      handler!({
        id: 'r2',
        content: 'live reply',
        createdAt: new Date().toISOString(),
        userId: 'u-other',
        parentId: 'p1',
      });
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-reply').length).toBe(2);
    });

    expect({
      given: 'a realtime reply arrives with matching parentId',
      should: 'append it to the reply list',
      actual: screen.getAllByTestId('thread-reply').length,
      expected: 2,
    }).toEqual({
      given: 'a realtime reply arrives with matching parentId',
      should: 'append it to the reply list',
      actual: 2,
      expected: 2,
    });
  });

  it('given alsoSendToParent twin events (reply + mirror), should append the reply but NOT the mirror to the thread list', async () => {
    renderPanel({
      fetcher: vi.fn(async () => ({ messages: [], hasMore: false, nextCursor: null })),
    });
    await waitFor(() => expect(screen.getByTestId('thread-divider-count')).toBeInTheDocument());

    const handler = mockSocketHandlers.get('new_message');
    expect(typeof handler).toBe('function');

    // Distinct content per event makes leakage text-detectable: the message
    // id is not rendered, so we can't probe by id. In production both bodies
    // are identical (same user message, mirrored); using different strings
    // here only matters to the test, not the contract under test.
    act(() => {
      handler!({
        id: 'reply-1',
        content: 'reply-body-A',
        createdAt: new Date('2026-05-05T12:00:00Z').toISOString(),
        userId: 'u-other',
        parentId: 'p1',
        mirroredFromId: null,
      });
      handler!({
        id: 'mirror-1',
        content: 'mirror-body-B',
        createdAt: new Date('2026-05-05T12:00:01Z').toISOString(),
        userId: 'u-other',
        parentId: null,
        mirroredFromId: 'reply-1',
      });
    });

    await waitFor(() => expect(screen.getAllByTestId('thread-reply').length).toBe(1));

    const replies = screen.getAllByTestId('thread-reply');
    const allText = replies.map((r) => r.textContent ?? '').join('\n');

    expect({
      given: 'reply (parentId=root) and mirror (parentId=null) twin events',
      should:
        'show exactly the reply in the thread list — the mirror is the page-side stream concern, not the panel',
      actual: {
        count: replies.length,
        replyShown: allText.includes('reply-body-A'),
        mirrorShown: allText.includes('mirror-body-B'),
      },
      expected: { count: 1, replyShown: true, mirrorShown: false },
    }).toEqual({
      given: 'reply (parentId=root) and mirror (parentId=null) twin events',
      should:
        'show exactly the reply in the thread list — the mirror is the page-side stream concern, not the panel',
      actual: { count: 1, replyShown: true, mirrorShown: false },
      expected: { count: 1, replyShown: true, mirrorShown: false },
    });
  });

  it('given the same id is broadcast twice (network double-fire), should not duplicate', async () => {
    renderPanel({
      fetcher: vi.fn(async () => ({ messages: [], hasMore: false, nextCursor: null })),
    });
    await waitFor(() => expect(screen.getByTestId('thread-divider-count')).toBeInTheDocument());

    const handler = mockSocketHandlers.get('new_message');
    expect(typeof handler).toBe('function');

    const payload = {
      id: 'reply-dup',
      content: 'doubled echo',
      createdAt: new Date('2026-05-05T12:02:00Z').toISOString(),
      userId: 'u-other',
      parentId: 'p1',
    };

    act(() => {
      handler!(payload);
      handler!(payload);
    });

    await waitFor(() => expect(screen.getAllByTestId('thread-reply').length).toBe(1));

    expect({
      given: 'the same realtime id is broadcast twice',
      should: 'render exactly one row (id-based dedupe in the realtime handler)',
      actual: screen.getAllByTestId('thread-reply').length,
      expected: 1,
    }).toEqual({
      given: 'the same realtime id is broadcast twice',
      should: 'render exactly one row (id-based dedupe in the realtime handler)',
      actual: 1,
      expected: 1,
    });
  });

  it('given a realtime new_message arrives with a non-matching parentId, should NOT append it', async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getAllByTestId('thread-reply').length).toBeGreaterThanOrEqual(1),
    );

    const handler = mockSocketHandlers.get('new_message');
    act(() => {
      handler!({
        id: 'r3',
        content: 'unrelated',
        createdAt: new Date().toISOString(),
        userId: 'u-other',
        parentId: 'different-root',
      });
    });

    expect({
      given: 'a realtime reply with non-matching parentId',
      should: 'leave reply count unchanged',
      actual: screen.getAllByTestId('thread-reply').length,
      expected: 1,
    }).toEqual({
      given: 'a realtime reply with non-matching parentId',
      should: 'leave reply count unchanged',
      actual: 1,
      expected: 1,
    });
  });

  it('given an empty reply list, should render the empty state', async () => {
    renderPanel({
      fetcher: vi.fn(async () => ({ messages: [], hasMore: false, nextCursor: null })),
    });

    await waitFor(() =>
      expect(screen.getByText(/start the thread/i)).toBeInTheDocument(),
    );

    expect({
      given: 'an empty reply list',
      should: 'render the empty state',
      actual: !!screen.queryByText(/start the thread/i),
      expected: true,
    }).toEqual({
      given: 'an empty reply list',
      should: 'render the empty state',
      actual: true,
      expected: true,
    });
  });

  it('given a successful POST, should upsert the persisted reply via SWR even when realtime never echoes', async () => {
    const user = userEvent.setup();
    postSpy.mockImplementationOnce(async () => ({
      id: 'r-server',
      content: 'no echo reply',
      createdAt: new Date('2026-05-05T12:30:00Z').toISOString(),
      userId: 'u-self',
      parentId: 'p1',
      reactions: [],
    }));
    renderPanel({
      fetcher: vi.fn(async () => ({ messages: [], hasMore: false, nextCursor: null })),
    });

    await waitFor(() => expect(screen.getByTestId('chat-textarea')).toBeInTheDocument());
    await user.type(screen.getByTestId('chat-textarea'), 'no echo reply{enter}');

    // POST resolves; no socket event is fired; the persisted row should still
    // appear and the optimistic temp row should be reconciled away.
    await waitFor(() => {
      const replies = screen.getAllByTestId('thread-reply');
      expect(replies.length).toBe(1);
    });
    expect({
      given: 'a successful POST without realtime echo',
      should: 'upsert the persisted reply and clear the optimistic temp',
      actual: screen.getAllByTestId('thread-reply').length,
      expected: 1,
    }).toEqual({
      given: 'a successful POST without realtime echo',
      should: 'upsert the persisted reply and clear the optimistic temp',
      actual: 1,
      expected: 1,
    });
  });

  it('given a DM thread send, should accept POST responses wrapped as { message }', async () => {
    const user = userEvent.setup();
    postSpy.mockImplementationOnce(async () => ({
      message: {
        id: 'r-dm-server',
        content: 'wrapped reply',
        createdAt: new Date('2026-05-05T12:31:00Z').toISOString(),
        senderId: 'u-self',
        parentId: 'p1',
      },
    }));
    renderPanel({
      source: 'dm',
      contextId: 'conv-1',
      fetcher: vi.fn(async () => ({ messages: [], hasMore: false, nextCursor: null })),
    });

    await waitFor(() => expect(screen.getByTestId('chat-textarea')).toBeInTheDocument());
    await user.type(screen.getByTestId('chat-textarea'), 'wrapped reply{enter}');

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-reply').length).toBe(1);
    });
    expect({
      given: 'a DM thread send with { message }-wrapped POST response',
      should: 'unwrap and upsert the persisted reply',
      actual: screen.getAllByTestId('thread-reply').length,
      expected: 1,
    }).toEqual({
      given: 'a DM thread send with { message }-wrapped POST response',
      should: 'unwrap and upsert the persisted reply',
      actual: 1,
      expected: 1,
    });
  });

  it('given two consecutive optimistic sends with identical content, should drop only one temp per server echo', async () => {
    const user = userEvent.setup();
    let postsCount = 0;
    postSpy.mockImplementation(async () => {
      // Don't return a usable id — force the panel to wait for the realtime
      // echo so the assertion is on the per-temp dedup logic, not the
      // POST-response upsert path.
      postsCount += 1;
      return undefined;
    });
    renderPanel({
      fetcher: vi.fn(async () => ({ messages: [], hasMore: false, nextCursor: null })),
    });

    await waitFor(() => expect(screen.getByTestId('chat-textarea')).toBeInTheDocument());
    const ta = screen.getByTestId('chat-textarea');
    await user.type(ta, 'dup{enter}');
    await user.type(ta, 'dup{enter}');

    await waitFor(() => expect(screen.getAllByTestId('thread-reply').length).toBe(2));

    const handler = mockSocketHandlers.get('new_message');
    expect(typeof handler).toBe('function');
    act(() => {
      handler!({
        id: 'r-echo-1',
        content: 'dup',
        createdAt: new Date().toISOString(),
        userId: 'u-self',
        parentId: 'p1',
      });
    });

    // After ONE echo: 1 temp dropped, 1 server row added → still 2 visible.
    await waitFor(() => expect(screen.getAllByTestId('thread-reply').length).toBe(2));

    expect({
      given: 'two duplicate-content optimistic sends and one realtime echo',
      should: 'only drop a single optimistic temp (not both)',
      actual: { posts: postsCount, replies: screen.getAllByTestId('thread-reply').length },
      expected: { posts: 2, replies: 2 },
    }).toEqual({
      given: 'two duplicate-content optimistic sends and one realtime echo',
      should: 'only drop a single optimistic temp (not both)',
      actual: { posts: 2, replies: 2 },
      expected: { posts: 2, replies: 2 },
    });
  });

  it('given the close button is clicked, should call onClose', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();

    await user.click(screen.getByTestId('thread-panel-close'));

    expect({
      given: 'close button clicked',
      should: 'call onClose',
      actual: onClose.mock.calls.length,
      expected: 1,
    }).toEqual({
      given: 'close button clicked',
      should: 'call onClose',
      actual: 1,
      expected: 1,
    });
  });

  it('given the GET response includes isFollowing=true, should label the toggle as Following', async () => {
    renderPanel({
      fetcher: vi.fn(async () => ({
        messages: [],
        hasMore: false,
        nextCursor: null,
        isFollowing: true,
      })),
    });
    await waitFor(() => {
      expect(screen.getByTestId('thread-follow-toggle').textContent).toContain('Following');
    });
    expect({
      given: 'a server response with isFollowing=true',
      should: 'render the header toggle in the Following state',
      actual: screen.getByTestId('thread-follow-toggle').getAttribute('aria-pressed'),
      expected: 'true',
    }).toEqual({
      given: 'a server response with isFollowing=true',
      should: 'render the header toggle in the Following state',
      actual: 'true',
      expected: 'true',
    });
  });

  it('given the user clicks the follow toggle, should POST to the follow endpoint and flip the label optimistically', async () => {
    const user = userEvent.setup();
    const { fetchWithAuth } = await import('@/lib/auth/auth-fetch');
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response('{}', { status: 200 }));
    renderPanel({
      fetcher: vi.fn(async () => ({
        messages: [],
        hasMore: false,
        nextCursor: null,
        isFollowing: false,
      })),
    });
    await waitFor(() => {
      expect(screen.getByTestId('thread-follow-toggle').textContent).toContain('Not following');
    });

    await user.click(screen.getByTestId('thread-follow-toggle'));

    await waitFor(() => {
      expect(vi.mocked(fetchWithAuth)).toHaveBeenCalledWith(
        '/api/channels/page-1/messages/p1/follow',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('thread-follow-toggle').textContent).toContain('Following');
    });
  });

  it('given a follow POST that fails, should revert the label to its prior state', async () => {
    const user = userEvent.setup();
    const { fetchWithAuth } = await import('@/lib/auth/auth-fetch');
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response('nope', { status: 500 }));
    renderPanel({
      fetcher: vi.fn(async () => ({
        messages: [],
        hasMore: false,
        nextCursor: null,
        isFollowing: false,
      })),
    });
    await waitFor(() => {
      expect(screen.getByTestId('thread-follow-toggle').textContent).toContain('Not following');
    });

    await user.click(screen.getByTestId('thread-follow-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('thread-follow-toggle').textContent).toContain('Not following');
    });
    expect({
      given: 'a follow POST that returns 500',
      should: 'revert the label back to the pre-click state',
      actual: screen.getByTestId('thread-follow-toggle').textContent?.includes('Not following'),
      expected: true,
    }).toEqual({
      given: 'a follow POST that returns 500',
      should: 'revert the label back to the pre-click state',
      actual: true,
      expected: true,
    });
  });
});
