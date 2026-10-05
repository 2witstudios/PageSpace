// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { fakeTurnStream, type FakeTurnStream } from '@/ui/test-support/fake-turn-stream';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { getUiState, setUiState } from '@/ui/store/store';
import { createInitialState } from '@/ui/store/state';
import { chatPaths } from '../chat-api/chat-api';
import { assistantWithTool, messagesPage, userMessage } from '../chat-model/fixtures';
import type { ChatMessage } from '../chat-model/chat';
import type { ContextRef } from '../chat-context/context-ref';
import { useAgentChat } from './use-agent-chat';

const TURN = `POST ${chatPaths.turn}`;
const ABORT = `POST ${chatPaths.abort}`;
const MESSAGES = `GET ${chatPaths.messages('p-imago', 'c1')}`;

const PAGE_REF: ContextRef = { routeType: 'page', pageId: 'p1', driveId: 'd1' };

beforeEach(() => {
  setUiState(createInitialState());
});

afterEach(() => {
  unmountAll();
});

// SWR and the stream resolve outside React's event loop. Each poll flushes what
// they scheduled in its own act(): an act() around the whole wait would hold
// every render back until the wait gave up.
const settle = (check: () => void, timeout = 1000): Promise<void> =>
  vi.waitFor(
    async () => {
      await act(async () => {});
      check();
    },
    { timeout, interval: 5 },
  );

type Chat = ReturnType<typeof useAgentChat>;
type Seen = { chat?: Chat };

/** Renders each message as one line, the way the pane will: text, and a tool part as name:state. */
const line = (message: ChatMessage) =>
  `${message.role}: ${message.parts
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type.startsWith('tool-')) return `[${part.type.slice(5)}:${(part as { state: string }).state}]`;
      return '';
    })
    .join('')}`;

const Probe = ({ seen, conversationId = 'c1' }: { seen: Seen; conversationId?: string | null }) => {
  const chat = useAgentChat('p-imago', conversationId, { contextRef: PAGE_REF });
  seen.chat = chat;
  return (
    <ol>
      {chat.messages?.map((message) => (
        <li key={message.id}>{line(message)}</li>
      ))}
    </ol>
  );
};

const rendered = (container: HTMLElement) => [...container.querySelectorAll('li')].map((item) => item.textContent);

const HISTORY = [userMessage('m1', 'Hi'), assistantWithTool('m2')];

/** A web whose messages route answers each GET with the next list given (the last one repeats). */
const chatWeb = (stream: FakeTurnStream, lists: readonly ChatMessage[][], extra: Record<string, FakeRoute> = {}) => {
  let reads = 0;
  return fakeWeb({
    [MESSAGES]: () => {
      const list = lists[Math.min(reads, lists.length - 1)] ?? [];
      reads += 1;
      return Response.json(messagesPage(list));
    },
    [TURN]: () => stream.response(),
    ...extra,
  });
};


/** A Probe the test can unmount and mount again under the same provider, as a pane that remounts. */
const Toggled = ({ seen, show }: { seen: Seen; show: { set?: (shown: boolean) => void } }) => {
  const [shown, setShown] = useState(true);
  show.set = setShown;
  return shown ? <Probe seen={seen} /> : null;
};

const mountChat = (web: ReturnType<typeof fakeWeb>, seen: Seen) =>
  mount(
    <ImagoSWRProvider client={web.client}>
      <Probe seen={seen} />
    </ImagoSWRProvider>,
  );

const loaded = (seen: Seen) => () => {
  if (seen.chat?.messages === undefined) throw new Error('not loaded');
};

describe('useAgentChat() send', () => {
  test('the request', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream, [HISTORY]);
    const seen: Seen = {};
    mountChat(web, seen);
    await settle(loaded(seen));

    act(() => {
      void seen.chat?.send('What does the roadmap say?');
    });
    await settle(() => {
      if (web.count(TURN) !== 1) throw new Error('not sent');
    });
    const sent = web.requests.find((request) => `${request.method} ${request.url}` === TURN);
    const body = sent?.body as { chatId: string; conversationId: string; contextRef: ContextRef; messages: ChatMessage[] };

    assert({
      given: 'a prompt sent from /imago/d1/files/p1',
      should: 'POST /api/ai/chat with the agent page id, the conversation id, the page context ref and the prompt in parts',
      actual: [body.chatId, body.conversationId, body.contextRef, body.messages.map((message) => [message.role, message.parts])],
      expected: ['p-imago', 'c1', PAGE_REF, [['user', [{ type: 'text', text: 'What does the roadmap say?' }]]]],
    });

    assert({
      given: 'a turn',
      should: 'never call a global route (DEC-3)',
      actual: web.requests.filter((request) => request.url.startsWith('/api/ai/global')),
      expected: [],
    });
    stream.close();
  });

  test('text and tool parts as they arrive', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream, [HISTORY]);
    const seen: Seen = {};
    const container = mountChat(web, seen);
    await settle(loaded(seen));

    act(() => {
      void seen.chat?.send('Summarise the roadmap');
    });
    await settle(() => {
      if (rendered(container).length !== 3) throw new Error('user message not shown');
    });
    const optimistic = rendered(container);

    stream.push({ type: 'start', messageId: 'a1' });
    stream.push({ type: 'tool-input-available', toolCallId: 'call-1', toolName: 'read_page', input: { pageId: 'p1' } });
    await settle(() => {
      if (rendered(container).at(-1) !== 'assistant: [read_page:input-available]') throw new Error('no tool call yet');
    });
    const toolCalled = rendered(container).at(-1);

    stream.push({ type: 'tool-output-available', toolCallId: 'call-1', output: { title: 'Roadmap' } });
    stream.push({ type: 'text-start', id: 't1' });
    stream.push({ type: 'text-delta', id: 't1', delta: 'Ship ' });
    await settle(() => {
      if (rendered(container).at(-1) !== 'assistant: [read_page:output-available]Ship ') throw new Error('no first delta');
    });
    const firstDelta = rendered(container).at(-1);

    stream.push({ type: 'text-delta', id: 't1', delta: 'in October.' });
    await settle(() => {
      if (!rendered(container).at(-1)?.endsWith('in October.')) throw new Error('no second delta');
    });

    assert({
      given: 'a reply streaming a tool call then text',
      should: 'show the prompt at once, then the tool part, its result and each text delta as they arrive',
      actual: [optimistic.at(-1), toolCalled, firstDelta, rendered(container).at(-1), seen.chat?.status],
      expected: [
        'user: Summarise the roadmap',
        'assistant: [read_page:input-available]',
        'assistant: [read_page:output-available]Ship ',
        'assistant: [read_page:output-available]Ship in October.',
        'streaming',
      ],
    });
    stream.close();
  });
});

describe('useAgentChat() streaming guard', () => {
  test('the streaming resource', async () => {
    const stream = fakeTurnStream();
    // After the turn the server holds the prompt under the id the client sent, and the reply.
    let persisted: ChatMessage[] = HISTORY;
    const web = chatWeb(stream, [HISTORY], {
      [MESSAGES]: () => Response.json(messagesPage(persisted)),
    });
    const seen: Seen = {};
    const container = mountChat(web, seen);
    await settle(loaded(seen));
    const before = getUiState().resources.streaming;

    act(() => {
      void seen.chat?.send('Go');
    });
    await settle(() => {
      if (getUiState().resources.streaming === null) throw new Error('not streaming');
    });
    const during = getUiState().resources.streaming;

    stream.push({ type: 'start', messageId: 'a1' });
    stream.push({ type: 'text-start', id: 't1' });
    stream.push({ type: 'text-delta', id: 't1', delta: 'Done.' });
    stream.push({ type: 'finish' });
    const prompt = (web.requests.find((request) => request.url === chatPaths.turn)?.body as { messages: ChatMessage[] }).messages[0];
    persisted = [...HISTORY, { ...userMessage(prompt?.id ?? '', 'Go') }, { ...assistantWithTool('a1'), parts: [{ type: 'text', text: 'Done, as saved.' }] }];
    stream.close();
    await settle(() => {
      if (seen.chat?.status !== 'ready' || web.count(MESSAGES) !== 2) throw new Error('not refetched');
    });

    assert({
      given: 'a turn from start to finish',
      should: 'set streaming to the conversation while it streams, clear it after, then show the persisted thread in place of the live turn',
      actual: [before, during, getUiState().resources.streaming, rendered(container)],
      expected: [
        null,
        { conversationId: 'c1' },
        null,
        ['user: Hi', 'assistant: [read_page:output-available]The roadmap says ship in October.', 'user: Go', 'assistant: Done, as saved.'],
      ],
    });
  });

  test('a revalidation mid-stream does not replace messages', async () => {
    const stream = fakeTurnStream();
    // The second read is what a revalidation would bring: a thread without the live turn.
    const web = chatWeb(stream, [HISTORY, [userMessage('m9', 'Someone else replaced this')]]);
    const seen: Seen = {};
    const container = mountChat(web, seen);
    await settle(loaded(seen));

    act(() => {
      void seen.chat?.send('Go');
    });
    stream.push({ type: 'start', messageId: 'a1' });
    stream.push({ type: 'text-start', id: 't1' });
    stream.push({ type: 'text-delta', id: 't1', delta: 'Partial' });
    await settle(() => {
      if (rendered(container).at(-1) !== 'assistant: Partial') throw new Error('not streaming yet');
    });
    const midStream = rendered(container);

    await act(() => seen.chat?.revalidate());
    window.dispatchEvent(new Event('focus'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    assert({
      given: 'an explicit and a focus revalidation of the streaming conversation',
      should: 'fetch nothing and keep every message on screen',
      actual: [web.count(MESSAGES), rendered(container)],
      expected: [1, midStream],
    });
    stream.close();
  });

  test('revalidation resumes after the stream', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream, [HISTORY, HISTORY, [userMessage('m9', 'Fresh')]]);
    const seen: Seen = {};
    mountChat(web, seen);
    await settle(loaded(seen));

    act(() => {
      void seen.chat?.send('Go');
    });
    stream.push({ type: 'start', messageId: 'a1' });
    stream.push({ type: 'finish' });
    stream.close();
    await settle(() => {
      if (seen.chat?.status !== 'ready' || web.count(MESSAGES) !== 2) throw new Error('not ended');
    });
    await act(() => seen.chat?.revalidate());
    await settle(() => {
      if (web.count(MESSAGES) !== 3) throw new Error('not revalidated');
    });

    assert({
      given: 'a revalidation once nothing streams',
      should: 'fetch the conversation again',
      actual: web.count(MESSAGES),
      expected: 3,
    });
  });

  test('a remount mid-stream still refreshes the thread', async () => {
    const stream = fakeTurnStream();
    let persisted: ChatMessage[] = HISTORY;
    const web = chatWeb(stream, [HISTORY], { [MESSAGES]: () => Response.json(messagesPage(persisted)) });
    const seen: Seen = {};
    const show: { set?: (shown: boolean) => void } = {};
    const container = mount(
      <ImagoSWRProvider client={web.client}>
        <Toggled seen={seen} show={show} />
      </ImagoSWRProvider>,
    );
    await settle(loaded(seen));

    act(() => {
      void seen.chat?.send('Go');
    });
    stream.push({ type: 'start', messageId: 'a1' });
    await settle(() => {
      if (web.count(TURN) !== 1) throw new Error('not sent');
    });
    act(() => show.set?.(false));
    act(() => show.set?.(true));

    const prompt = (web.requests.find((request) => request.url === chatPaths.turn)?.body as { messages: ChatMessage[] }).messages[0];
    persisted = [...HISTORY, userMessage(prompt?.id ?? '', 'Go'), { ...assistantWithTool('a1'), parts: [{ type: 'text', text: 'Saved.' }] }];
    stream.push({ type: 'finish' });
    stream.close();
    await settle(() => {
      if (getUiState().resources.streaming !== null || web.count(MESSAGES) !== 2) throw new Error('not refreshed');
    });
    await settle(() => {
      if (rendered(container).length !== 4) throw new Error('not rendered');
    });

    assert({
      given: 'the chat remounted while its turn streamed, then the turn ending',
      should: 'read the thread again and show the stored prompt and reply',
      actual: rendered(container).slice(-2),
      expected: ['user: Go', 'assistant: Saved.'],
    });
  });

  test('a fresh mount mid-stream loads once the stream ends', async () => {
    const stream = fakeTurnStream();
    let persisted: ChatMessage[] = HISTORY;
    const web = chatWeb(stream, [HISTORY], { [MESSAGES]: () => Response.json(messagesPage(persisted)) });
    const sender: Seen = {};
    const first = mount(
      <ImagoSWRProvider client={web.client}>
        <Probe seen={sender} />
      </ImagoSWRProvider>,
    );
    await settle(loaded(sender));
    act(() => {
      void sender.chat?.send('Go');
    });
    stream.push({ type: 'start', messageId: 'a1' });
    await settle(() => {
      if (web.count(TURN) !== 1) throw new Error('not sent');
    });
    unmountAll();
    void first;

    // A new provider and a new pane while the turn still streams: its first load waits.
    const seen: Seen = {};
    const container = mount(
      <ImagoSWRProvider client={web.client}>
        <Probe seen={seen} />
      </ImagoSWRProvider>,
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    const whileStreaming = [web.count(MESSAGES), seen.chat?.messages];

    persisted = [...HISTORY, userMessage('u-any', 'Go')];
    stream.push({ type: 'finish' });
    stream.close();
    await settle(() => {
      if (rendered(container).length !== 3) throw new Error('not loaded after the stream');
    });

    assert({
      given: 'a fresh pane mounted while another pane\'s turn streamed',
      should: 'hold its load during the stream and load the stored thread once it ends',
      actual: [whileStreaming, web.count(MESSAGES), rendered(container).at(-1)],
      expected: [[1, undefined], 2, 'user: Go'],
    });
  });
});

describe('useAgentChat() stop', () => {
  test('aborts via /api/ai/abort and keeps the partial reply', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream, [HISTORY], {
      // The server stops the generation: it writes an abort frame and closes the body.
      [ABORT]: () => {
        stream.push({ type: 'abort' });
        stream.close();
        return Response.json({ aborted: true });
      },
    });
    const seen: Seen = {};
    const container = mountChat(web, seen);
    await settle(loaded(seen));

    act(() => {
      void seen.chat?.send('Write a long essay');
    });
    stream.push({ type: 'start', messageId: 'a1' });
    stream.push({ type: 'text-start', id: 't1' });
    stream.push({ type: 'text-delta', id: 't1', delta: 'Once upon' });
    await settle(() => {
      if (rendered(container).at(-1) !== 'assistant: Once upon') throw new Error('not streaming yet');
    });

    await act(() => seen.chat?.stop());
    await settle(() => {
      if (seen.chat?.status !== 'ready') throw new Error('not stopped');
    });

    assert({
      given: 'stop mid-reply',
      should: 'POST /api/ai/abort naming the conversation and reply, clear streaming and keep the partial reply',
      actual: [
        web.requests.filter((request) => request.url === chatPaths.abort).map((request) => [request.body, request.csrf]),
        getUiState().resources.streaming,
        rendered(container).slice(-2),
      ],
      expected: [
        [[{ conversationId: 'c1', messageId: 'a1' }, 'tok-1']],
        null,
        ['user: Write a long essay', 'assistant: Once upon'],
      ],
    });
  });

  test('stops reading once the server has stopped', async () => {
    const stream = fakeTurnStream();
    // The server confirms the stop but its body stays open, still flushing.
    const web = chatWeb(stream, [HISTORY], { [ABORT]: () => Response.json({ aborted: true }) });
    const seen: Seen = {};
    const container = mountChat(web, seen);
    await settle(loaded(seen));

    act(() => {
      void seen.chat?.send('Go');
    });
    stream.push({ type: 'start', messageId: 'a1' });
    stream.push({ type: 'text-start', id: 't1' });
    stream.push({ type: 'text-delta', id: 't1', delta: 'Kept' });
    await settle(() => {
      if (rendered(container).at(-1) !== 'assistant: Kept') throw new Error('not streaming yet');
    });
    await act(() => seen.chat?.stop());
    await settle(() => {
      if (seen.chat?.status !== 'ready') throw new Error('still reading');
    });
    stream.push({ type: 'text-delta', id: 't1', delta: ' and more' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));

    assert({
      given: 'a confirmed stop while the body stays open',
      should: 'cancel the body, end the turn and render nothing that arrives after',
      actual: [stream.cancelled(), getUiState().resources.streaming, rendered(container).at(-1)],
      expected: [true, null, 'assistant: Kept'],
    });
  });

  test('before the reply is named', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream, [HISTORY], {
      [ABORT]: () => {
        stream.close();
        return Response.json({ aborted: true });
      },
    });
    const seen: Seen = {};
    mountChat(web, seen);
    await settle(loaded(seen));

    act(() => {
      void seen.chat?.send('Go');
    });
    await settle(() => {
      if (web.count(TURN) !== 1) throw new Error('not sent');
    });
    await act(() => seen.chat?.stop());
    await settle(() => {
      if (seen.chat?.status !== 'ready') throw new Error('not stopped');
    });

    assert({
      given: 'stop before the start frame',
      should: 'name only the conversation, and end the turn',
      actual: [web.requests.filter((request) => request.url === chatPaths.abort).map((request) => request.body), getUiState().resources.streaming],
      expected: [[{ conversationId: 'c1' }], null],
    });
  });

  test('a refused stop', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream, [HISTORY], {
      [ABORT]: () => Response.json({ error: 'Too many requests. Please try again later.' }, { status: 429 }),
    });
    const seen: Seen = {};
    const container = mountChat(web, seen);
    await settle(loaded(seen));

    act(() => {
      void seen.chat?.send('Go');
    });
    stream.push({ type: 'start', messageId: 'a1' });
    stream.push({ type: 'text-start', id: 't1' });
    stream.push({ type: 'text-delta', id: 't1', delta: 'Still ' });
    await settle(() => {
      if (rendered(container).at(-1) !== 'assistant: Still ') throw new Error('not streaming yet');
    });
    await act(() => seen.chat?.stop());
    stream.push({ type: 'text-delta', id: 't1', delta: 'going' });
    await settle(() => {
      if (rendered(container).at(-1) !== 'assistant: Still going') throw new Error('reading stopped');
    });

    assert({
      given: 'a stop the server refuses',
      should: 'say why, and keep reading the reply that is still generating',
      actual: [
        seen.chat?.error instanceof Error ? seen.chat.error.message : seen.chat?.error,
        seen.chat?.status,
        getUiState().resources.streaming,
      ],
      expected: ['Too many requests. Please try again later.', 'streaming', { conversationId: 'c1' }],
    });
    stream.close();
    await settle(() => {
      if (seen.chat?.status !== 'ready') throw new Error('not ended');
    });
  });

  test('nothing streaming', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream, [HISTORY]);
    const seen: Seen = {};
    mountChat(web, seen);
    await settle(loaded(seen));
    await act(() => seen.chat?.stop());

    assert({
      given: 'stop with no turn in flight',
      should: 'call nothing',
      actual: web.requests.filter((request) => request.url === chatPaths.abort).length,
      expected: 0,
    });
  });
});

describe('useAgentChat() failures', () => {
  test('a refused turn', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream, [HISTORY], {
      [TURN]: () => Response.json({ error: 'Insufficient permissions' }, { status: 403 }),
    });
    const seen: Seen = {};
    const container = mountChat(web, seen);
    await settle(loaded(seen));

    await act(async () => {
      await seen.chat?.send('Go');
    });

    assert({
      given: 'the server refusing the turn',
      should: 'report the error, clear streaming and drop the unsent prompt',
      actual: [
        seen.chat?.status,
        seen.chat?.error instanceof Error ? seen.chat.error.message : seen.chat?.error,
        getUiState().resources.streaming,
        rendered(container).length,
      ],
      expected: ['error', 'Insufficient permissions', null, 2],
    });
  });

  test('one turn at a time', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream, [HISTORY]);
    const seen: Seen = {};
    mountChat(web, seen);
    await settle(loaded(seen));

    act(() => {
      void seen.chat?.send('First');
    });
    await settle(() => {
      if (web.count(TURN) !== 1) throw new Error('not sent');
    });
    await act(() => seen.chat?.send('Second'));

    assert({
      given: 'a send while a turn streams',
      should: 'not start a second turn',
      actual: web.count(TURN),
      expected: 1,
    });
    stream.close();
  });

  test('blank prompts and no conversation', async () => {
    const stream = fakeTurnStream();
    const web = chatWeb(stream, [HISTORY]);
    const seen: Seen = {};
    mountChat(web, seen);
    await settle(loaded(seen));
    await act(() => seen.chat?.send('   '));

    const noConversation: Seen = {};
    mount(
      <ImagoSWRProvider client={web.client}>
        <Probe seen={noConversation} conversationId={null} />
      </ImagoSWRProvider>,
    );
    await act(() => noConversation.chat?.send('Hello'));

    assert({
      given: 'a blank prompt, or no conversation chosen',
      should: 'send nothing',
      actual: web.count(TURN),
      expected: 0,
    });
  });
});
