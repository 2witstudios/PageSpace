import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { ApiError, INVALID_RESPONSE } from '@/api/errors';
import {
  chatPaths,
  CONVERSATIONS_PAGE_SIZE,
  createConversation,
  fetchBuiltinAgents,
  fetchDriveAgents,
  fetchConversationMessages,
  fetchConversationsPage,
  MESSAGES_PAGE_SIZE,
} from './chat-api';
import {
  agentConversation,
  assistantWithTool,
  conversationsPage,
  driveAgentsBody,
  messagesPage,
  pointers,
  userMessage,
} from '../chat-model/fixtures';

const caught = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
};

const failure = (error: unknown) => (error instanceof ApiError ? [error.status, error.code, error.message] : error);

describe('chatPaths', () => {
  test('routes', () => {
    assert({
      given: 'agent and conversation ids, a page and a cursor',
      should: "address apps/web's page-agent routes, encoded",
      actual: [
        chatPaths.builtinAgents,
        chatPaths.conversations('a 1', 0),
        chatPaths.conversations('a1', 2),
        chatPaths.messages('a1', 'c/1'),
        chatPaths.messages('a1', 'c1', 'm 9'),
        chatPaths.driveAgents('d 1'),
      ],
      expected: [
        '/api/user/builtin-agents',
        `/api/ai/page-agents/a%201/conversations?page=0&pageSize=${CONVERSATIONS_PAGE_SIZE}`,
        `/api/ai/page-agents/a1/conversations?page=2&pageSize=${CONVERSATIONS_PAGE_SIZE}`,
        `/api/ai/page-agents/a1/conversations/c%2F1/messages?limit=${MESSAGES_PAGE_SIZE}`,
        `/api/ai/page-agents/a1/conversations/c1/messages?limit=${MESSAGES_PAGE_SIZE}&direction=before&cursor=m%209`,
        '/api/drives/d%201/agents?includeTools=false',
      ],
    });
  });

  test('never the global pipeline', () => {
    const paths = [
      chatPaths.builtinAgents,
      chatPaths.conversations('a1', 0),
      chatPaths.messages('a1', 'c1'),
      chatPaths.messages('a1', 'c1', 'm1'),
      chatPaths.driveAgents('d1'),
    ];

    assert({
      given: 'every path the chat data layer reads',
      should: 'stay off /api/ai/global/* (DEC-3)',
      actual: paths.filter((path) => path.startsWith('/api/ai/global')),
      expected: [],
    });
  });
});

describe('fetchBuiltinAgents()', () => {
  test('pointers', async () => {
    const web = fakeWeb({ [`GET ${chatPaths.builtinAgents}`]: () => Response.json(pointers({ 'imago-researcher': null })) });

    assert({
      given: "the viewer's pointers, one not provisioned yet",
      should: 'give every key in registry order, keeping the null pageId',
      actual: await fetchBuiltinAgents(web.client),
      expected: [
        { key: 'imago', pageId: 'p-imago', title: 'Imago' },
        { key: 'imago-planner', pageId: 'p-planner', title: 'Planner' },
        { key: 'imago-researcher', pageId: null, title: 'Researcher' },
      ],
    });
  });

  test('a body without agents', async () => {
    const web = fakeWeb({ [`GET ${chatPaths.builtinAgents}`]: () => Response.json({}) });

    assert({
      given: 'a 200 whose body has no agents list',
      should: 'reject as an invalid response instead of passing undefined on',
      actual: failure(await caught(fetchBuiltinAgents(web.client))),
      expected: [200, INVALID_RESPONSE, 'Built-in agents response carried no agents'],
    });
  });

  test('a refusal', async () => {
    const web = fakeWeb({
      [`GET ${chatPaths.builtinAgents}`]: () => Response.json({ error: 'Failed to fetch built-in agents' }, { status: 500 }),
    });

    assert({
      given: 'apps/web failing',
      should: 'reject with its ApiError',
      actual: failure(await caught(fetchBuiltinAgents(web.client))),
      expected: [500, null, 'Failed to fetch built-in agents'],
    });
  });
});

describe('fetchDriveAgents()', () => {
  test('the agents the server lists', async () => {
    const web = fakeWeb({
      [`GET ${chatPaths.driveAgents('d1')}`]: () => {
        const body = driveAgentsBody([
          { id: 'a1', title: 'Support' },
          { id: 'a2', title: null },
          { id: '', title: 'Broken' },
          { title: 'No id' },
        ]);
        return Response.json({ ...body, agents: [...body.agents, null, 'a3'] });
      },
    });

    assert({
      given: "the drive's agents as GET /api/drives/[driveId]/agents answers them, one untitled and four malformed",
      should: 'give every well-formed one in the order given, an untitled one by a stand-in name, and drop the rest',
      actual: await fetchDriveAgents(web.client, 'd1'),
      expected: [
        { id: 'a1', title: 'Support' },
        { id: 'a2', title: 'Untitled agent' },
      ],
    });
  });

  test('a body without agents', async () => {
    const web = fakeWeb({ [`GET ${chatPaths.driveAgents('d1')}`]: () => Response.json({ success: true }) });

    assert({
      given: 'a 200 whose body has no agents list',
      should: 'reject as an invalid response',
      actual: failure(await caught(fetchDriveAgents(web.client, 'd1'))),
      expected: [200, INVALID_RESPONSE, 'Drive agents response carried no agents'],
    });
  });

  test('a refusal', async () => {
    const web = fakeWeb({
      [`GET ${chatPaths.driveAgents('d1')}`]: () => Response.json({ error: "You don't have access to this drive" }, { status: 403 }),
    });

    assert({
      given: 'a drive the viewer cannot reach',
      should: 'reject with its ApiError',
      actual: failure(await caught(fetchDriveAgents(web.client, 'd1'))),
      expected: [403, null, "You don't have access to this drive"],
    });
  });
});

describe('fetchConversationsPage()', () => {
  test('a page', async () => {
    const web = fakeWeb({
      [`GET ${chatPaths.conversations('a1', 1)}`]: () =>
        Response.json(
          conversationsPage([agentConversation('c3'), agentConversation('c4', { sessionId: 'ws1' })], {
            page: 1,
            pageSize: CONVERSATIONS_PAGE_SIZE,
            totalCount: CONVERSATIONS_PAGE_SIZE * 3,
          }),
        ),
    });
    const page = await fetchConversationsPage(web.client, 'a1', 1);

    assert({
      given: 'page 1 of an agent with more conversations after it',
      should: 'give that page, most recent first, and say there is more',
      actual: [page.conversations.map(({ id, sessionId }) => ({ id, sessionId })), page.hasMore],
      expected: [
        [
          { id: 'c3', sessionId: null },
          { id: 'c4', sessionId: 'ws1' },
        ],
        true,
      ],
    });
  });

  test('the last page', async () => {
    const web = fakeWeb({
      [`GET ${chatPaths.conversations('a1', 0)}`]: () => Response.json(conversationsPage([agentConversation('c1')])),
    });

    assert({
      given: 'every conversation on one page',
      should: 'say there is no more',
      actual: (await fetchConversationsPage(web.client, 'a1', 0)).hasMore,
      expected: false,
    });
  });

  test('a refusal', async () => {
    const web = fakeWeb({
      [`GET ${chatPaths.conversations('a1', 0)}`]: () =>
        Response.json({ error: 'Insufficient permissions to view this agent' }, { status: 403 }),
    });

    assert({
      given: 'an agent the viewer cannot see',
      should: 'reject with the 403',
      actual: failure(await caught(fetchConversationsPage(web.client, 'a1', 0))),
      expected: [403, null, 'Insufficient permissions to view this agent'],
    });
  });

  test('a body without conversations', async () => {
    const web = fakeWeb({ [`GET ${chatPaths.conversations('a1', 0)}`]: () => Response.json({ pagination: {} }) });

    assert({
      given: 'a 200 with no conversations list',
      should: 'reject as an invalid response',
      actual: failure(await caught(fetchConversationsPage(web.client, 'a1', 0))),
      expected: [200, INVALID_RESPONSE, 'Conversations response carried no conversations'],
    });
  });
});

describe('fetchConversationMessages()', () => {
  test('the newest page, parts intact', async () => {
    const sent = [userMessage('m1', 'What does the roadmap say?'), assistantWithTool('m2')];
    const web = fakeWeb({
      [`GET ${chatPaths.messages('a1', 'c1')}`]: () => Response.json(messagesPage(sent, { nextCursor: 'm1', rev: 12 })),
    });
    const page = await fetchConversationMessages(web.client, 'a1', 'c1');

    assert({
      given: 'a conversation with older messages before this page',
      should: 'give its messages oldest first with their parts exactly as sent, the older cursor and the rev',
      actual: page,
      expected: { messages: sent, olderCursor: 'm1', rev: 12 },
    });
  });

  test('an older page', async () => {
    const web = fakeWeb({
      [`GET ${chatPaths.messages('a1', 'c1', 'm1')}`]: () =>
        Response.json(messagesPage([userMessage('m0', 'hi')], { nextCursor: null, rev: null })),
    });

    assert({
      given: 'a cursor reaching the start of the conversation',
      should: 'load before it and say there is nothing older',
      actual: await fetchConversationMessages(web.client, 'a1', 'c1', 'm1'),
      expected: { messages: [userMessage('m0', 'hi')], olderCursor: null, rev: null },
    });
  });

  test('a cursor without hasMore', async () => {
    const web = fakeWeb({
      [`GET ${chatPaths.messages('a1', 'c1')}`]: () =>
        Response.json({ ...messagesPage([userMessage('m1', 'hi')]), pagination: { ...messagesPage([]).pagination, hasMore: false, nextCursor: 'm1' } }),
    });

    assert({
      given: 'the server saying there is no more',
      should: 'offer no older cursor whatever nextCursor holds',
      actual: (await fetchConversationMessages(web.client, 'a1', 'c1')).olderCursor,
      expected: null,
    });
  });

  test('a private conversation of someone else', async () => {
    const web = fakeWeb({
      [`GET ${chatPaths.messages('a1', 'c1')}`]: () =>
        Response.json({ error: 'Insufficient permissions to access this conversation' }, { status: 403 }),
    });

    assert({
      given: 'apps/web refusing the conversation',
      should: 'reject with the 403',
      actual: failure(await caught(fetchConversationMessages(web.client, 'a1', 'c1'))),
      expected: [403, null, 'Insufficient permissions to access this conversation'],
    });
  });

  test('a body without messages', async () => {
    const web = fakeWeb({ [`GET ${chatPaths.messages('a1', 'c1')}`]: () => Response.json([]) });

    assert({
      given: 'a 200 that is not the messages envelope',
      should: 'reject as an invalid response',
      actual: failure(await caught(fetchConversationMessages(web.client, 'a1', 'c1'))),
      expected: [200, INVALID_RESPONSE, 'Messages response carried no messages'],
    });
  });
});

describe('createConversation()', () => {
  test('a new conversation', async () => {
    const web = fakeWeb({
      [`POST ${chatPaths.newConversation('p 1')}`]: () =>
        Response.json({ conversationId: 'c-new', title: 'New conversation', createdAt: '2026-10-05T10:00:00.000Z' }),
    });
    const id = await createConversation(web.client, 'p 1');
    assert({
      given: 'an agent page',
      should: 'create a conversation with it through the page-agent route, with CSRF, and answer its id',
      actual: [id, web.writes().map((request) => [request.method, request.url, request.csrf, request.body])],
      expected: ['c-new', [['POST', '/api/ai/page-agents/p%201/conversations', 'tok-1', {}]]],
    });
  });

  test('a malformed answer', async () => {
    const web = fakeWeb({
      [`POST ${chatPaths.newConversation('p1')}`]: () => Response.json({ title: 'New conversation' }),
    });
    assert({
      given: 'an answer with no conversation id',
      should: 'reject with an invalid-response error',
      actual: failure(await caught(createConversation(web.client, 'p1'))),
      expected: [200, INVALID_RESPONSE, 'Conversation response carried no id'],
    });
  });
});
