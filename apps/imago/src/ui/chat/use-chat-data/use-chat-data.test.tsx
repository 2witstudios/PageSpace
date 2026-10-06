// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { ApiError } from '@/api/errors';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { setUiState } from '@/ui/store/store';
import { createInitialState } from '@/ui/store/state';
import { dispatch, transactions } from '@/ui/store/transactions';
import { useAgentConversations, useConversationMessages, useImagoAgents } from './use-chat-data';
import { chatPaths, CONVERSATIONS_PAGE_SIZE } from '../chat-api/chat-api';
import {
  agentConversation,
  assistantWithTool,
  conversationsPage,
  messagesPage,
  pointers,
  userMessage,
} from '../chat-model/fixtures';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
});

// SWR resolves outside React's event loop; waiting inside act() flushes the
// state updates it causes.
const settle = (check: () => void, timeout = 1000): Promise<void> =>
  act(() => vi.waitFor(check, { timeout, interval: 5 }));

const mount = (routes: Record<string, FakeRoute>, probe: React.ReactNode, { strict = false } = {}) => {
  const web = fakeWeb(routes);
  const tree = <ImagoSWRProvider client={web.client}>{probe}</ImagoSWRProvider>;
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
  return web;
};

const AGENTS = `GET ${chatPaths.builtinAgents}`;
const conversationsAt = (page: number) => `GET ${chatPaths.conversations('p-imago', page)}`;
const messagesAt = (cursor?: string) => `GET ${chatPaths.messages('p-imago', 'c1', cursor)}`;

const ids = (rows: readonly { id: string }[] | undefined) => rows?.map((row) => row.id);

/** Every request the web saw went to an allowed chat route, never /api/ai/global/*. */
const offGlobal = (urls: readonly string[]) => urls.filter((url) => url.startsWith('/api/ai/global'));

describe('useImagoAgents()', () => {
  type Seen = { agents?: ReturnType<typeof useImagoAgents> };
  const Probe = ({ seen }: { seen: Seen }) => {
    seen.agents = useImagoAgents();
    return null;
  };

  test('loading', async () => {
    const seen: Seen = {};
    const web = mount({ [AGENTS]: () => Response.json(pointers({ imago: null })) }, <Probe seen={seen} />, {
      strict: true,
    });
    await settle(() => {
      if (seen.agents?.agents === undefined) throw new Error('not loaded');
    });

    assert({
      given: 'a viewer whose Imago is not provisioned yet',
      should: 'load the pointer once from /api/user/builtin-agents, keeping the null pageId',
      actual: [seen.agents?.agents?.map(({ key, pageId }) => `${key}:${pageId}`), web.count(AGENTS)],
      expected: [['imago:null'], 1],
    });
  });

  test('a failure', async () => {
    const seen: Seen = {};
    mount({ [AGENTS]: () => Response.json({ error: 'Unauthorized' }, { status: 403 }) }, <Probe seen={seen} />);
    await settle(() => {
      if (seen.agents?.error === undefined) throw new Error('no error yet');
    });

    assert({
      given: 'apps/web refusing the pointers',
      should: 'expose the ApiError and no agents',
      actual: [seen.agents?.error instanceof ApiError, seen.agents?.agents],
      expected: [true, undefined],
    });
  });
});

describe('useAgentConversations()', () => {
  type Seen = { list?: ReturnType<typeof useAgentConversations> };
  const Probe = ({ seen, agentId }: { seen: Seen; agentId: string | null }) => {
    seen.list = useAgentConversations(agentId);
    return null;
  };

  test('first page', async () => {
    const seen: Seen = {};
    const web = mount(
      { [conversationsAt(0)]: () => Response.json(conversationsPage([agentConversation('c2'), agentConversation('c1')])) },
      <Probe seen={seen} agentId="p-imago" />,
      { strict: true },
    );
    await settle(() => {
      if (seen.list?.conversations === undefined) throw new Error('not loaded');
    });

    assert({
      given: 'an agent page id',
      should: "list the viewer's conversations with it, most recent first, from its page-agent route",
      actual: [ids(seen.list?.conversations), seen.list?.hasMore, web.count(conversationsAt(0)), offGlobal(web.requests.map((r) => r.url))],
      expected: [['c2', 'c1'], false, 1, []],
    });
  });

  test('more pages', async () => {
    const seen: Seen = {};
    const total = CONVERSATIONS_PAGE_SIZE + 1;
    const first = Array.from({ length: CONVERSATIONS_PAGE_SIZE }, (_, n) => agentConversation(`c${n}`));
    const web = mount(
      {
        [conversationsAt(0)]: () => Response.json(conversationsPage(first, { totalCount: total })),
        // A conversation created meanwhile shifts the offsets: page 1 repeats
        // the last row of page 0.
        [conversationsAt(1)]: () =>
          Response.json(
            conversationsPage([agentConversation(`c${CONVERSATIONS_PAGE_SIZE - 1}`), agentConversation('c-last')], {
              page: 1,
              totalCount: total + 1,
            }),
          ),
      },
      <Probe seen={seen} agentId="p-imago" />,
    );
    await settle(() => {
      if (seen.list?.conversations === undefined) throw new Error('not loaded');
    });

    const before = [seen.list?.conversations?.length, seen.list?.hasMore, web.count(conversationsAt(1))];
    await act(() => seen.list?.loadMore());
    await settle(() => {
      if (seen.list?.conversations?.length !== CONVERSATIONS_PAGE_SIZE + 1) throw new Error('page 1 not loaded');
    });

    assert({
      given: 'an agent with more conversations than one page',
      should: 'load the next page only when asked, once per conversation',
      actual: [before, ids(seen.list?.conversations)?.slice(-2), seen.list?.hasMore],
      expected: [[CONVERSATIONS_PAGE_SIZE, true, 0], [`c${CONVERSATIONS_PAGE_SIZE - 1}`, 'c-last'], false],
    });
  });

  test('no agent page', () => {
    const seen: Seen = {};
    const web = mount({}, <Probe seen={seen} agentId={null} />);

    assert({
      given: 'an Imago agent whose pageId is null (not provisioned)',
      should: 'fetch nothing and list nothing',
      actual: [seen.list?.conversations, seen.list?.hasMore, web.requests.length],
      expected: [undefined, false, 0],
    });
  });

  test('a refusal', async () => {
    const seen: Seen = {};
    mount(
      { [conversationsAt(0)]: () => Response.json({ error: 'Insufficient permissions to view this agent' }, { status: 403 }) },
      <Probe seen={seen} agentId="p-imago" />,
    );
    await settle(() => {
      if (seen.list?.error === undefined) throw new Error('no error yet');
    });

    assert({
      given: 'an agent the viewer cannot see',
      should: 'expose the 403',
      actual: seen.list?.error instanceof ApiError ? seen.list.error.status : seen.list?.error,
      expected: 403,
    });
  });
});

describe('useConversationMessages()', () => {
  type Seen = { thread?: ReturnType<typeof useConversationMessages> };
  const Probe = ({
    seen,
    agentId = 'p-imago',
    conversationId = 'c1',
  }: {
    seen: Seen;
    agentId?: string | null;
    conversationId?: string | null;
  }) => {
    seen.thread = useConversationMessages(agentId, conversationId);
    return null;
  };

  test('newest page, parts intact', async () => {
    const seen: Seen = {};
    const newest = [userMessage('m3', 'What does the roadmap say?'), assistantWithTool('m4')];
    const web = mount(
      { [messagesAt()]: () => Response.json(messagesPage(newest, { nextCursor: 'm3', rev: 4 })) },
      <Probe seen={seen} />,
      { strict: true },
    );
    await settle(() => {
      if (seen.thread?.messages === undefined) throw new Error('not loaded');
    });

    assert({
      given: 'a conversation',
      should: 'load its newest messages oldest first, parts exactly as sent, with the rev and an older page on offer',
      actual: [seen.thread?.messages, seen.thread?.hasOlder, seen.thread?.rev, web.count(messagesAt()), offGlobal(web.requests.map((r) => r.url))],
      expected: [newest, true, 4, 1, []],
    });
  });

  test('moving to another conversation while one streams', async () => {
    setUiState(createInitialState());
    const seen: Seen = {};
    const other = `GET ${chatPaths.messages('p-imago', 'c2')}`;
    const web = fakeWeb({
      [messagesAt()]: () => Response.json(messagesPage([userMessage('m1', 'Streaming here')])),
      [other]: () => Response.json(messagesPage([userMessage('m9', 'Another thread')], { conversationId: 'c2' })),
    });
    const root = createRoot(document.createElement('div'));
    roots.push(root);
    const show = (conversationId: string) =>
      act(() => {
        root.render(
          <ImagoSWRProvider client={web.client}>
            <Probe seen={seen} conversationId={conversationId} />
          </ImagoSWRProvider>,
        );
      });
    show('c1');
    await settle(() => {
      if (seen.thread?.messages === undefined) throw new Error('not loaded');
    });
    act(() => dispatch(transactions.startStreaming, 'c1'));
    show('c2');
    try {
      await settle(() => {
        if (seen.thread?.messages?.[0]?.id !== 'm9') throw new Error('c2 not loaded');
      });
    } catch {
      // Asserted below, once the stream has ended for the next test.
    }
    const actual = [ids(seen.thread?.messages), web.count(other), web.count(messagesAt())];
    act(() => dispatch(transactions.endStreaming, 'c1'));

    assert({
      given: 'a turn streaming into c1 when the hook moves to c2',
      should: 'load c2 (only the streaming conversation is paused), and leave c1 alone',
      actual,
      expected: [['m9'], 1, 1],
    });
  });

  test('older messages', async () => {
    const seen: Seen = {};
    mount(
      {
        [messagesAt()]: () => Response.json(messagesPage([userMessage('m3', 'again'), assistantWithTool('m4')], { nextCursor: 'm3', rev: 4 })),
        [messagesAt('m3')]: () =>
          Response.json(messagesPage([userMessage('m1', 'first'), userMessage('m2', 'second')], { nextCursor: null, rev: 2 })),
      },
      <Probe seen={seen} />,
    );
    await settle(() => {
      if (seen.thread?.messages === undefined) throw new Error('not loaded');
    });

    await act(() => seen.thread?.loadOlder());
    await settle(() => {
      if (seen.thread?.messages?.length !== 4) throw new Error('older page not loaded');
    });

    assert({
      given: 'loadOlder on a conversation with an older page',
      should: 'put the older messages before the newer ones, offer nothing older after the start, and keep the newest page\'s rev',
      actual: [ids(seen.thread?.messages), seen.thread?.hasOlder, seen.thread?.rev],
      expected: [['m1', 'm2', 'm3', 'm4'], false, 4],
    });
  });

  test('nothing older', async () => {
    const seen: Seen = {};
    const web = mount(
      { [messagesAt()]: () => Response.json(messagesPage([userMessage('m1', 'hi')], { nextCursor: null })) },
      <Probe seen={seen} />,
    );
    await settle(() => {
      if (seen.thread?.messages === undefined) throw new Error('not loaded');
    });
    await act(() => seen.thread?.loadOlder());

    assert({
      given: 'loadOlder on a conversation already loaded from its start',
      should: 'request nothing more',
      actual: [seen.thread?.hasOlder, web.requests.length],
      expected: [false, 1],
    });
  });

  test('no agent or no conversation', () => {
    const seen: Seen = {};
    const noAgent = mount({}, <Probe seen={seen} agentId={null} />);
    const noAgentSeen = [seen.thread?.messages, noAgent.requests.length];
    const noConversation = mount({}, <Probe seen={seen} conversationId={null} />);

    assert({
      given: 'an unprovisioned agent, or no conversation chosen yet',
      should: 'fetch nothing',
      actual: [noAgentSeen, [seen.thread?.messages, noConversation.requests.length]],
      expected: [
        [undefined, 0],
        [undefined, 0],
      ],
    });
  });

  test('a refusal', async () => {
    const seen: Seen = {};
    mount(
      { [messagesAt()]: () => Response.json({ error: 'Insufficient permissions to access this conversation' }, { status: 403 }) },
      <Probe seen={seen} />,
    );
    await settle(() => {
      if (seen.thread?.error === undefined) throw new Error('no error yet');
    });

    assert({
      given: "someone else's private conversation",
      should: 'expose the 403 and no messages',
      actual: [seen.thread?.error instanceof ApiError ? seen.thread.error.status : seen.thread?.error, seen.thread?.messages],
      expected: [403, undefined],
    });
  });
});
