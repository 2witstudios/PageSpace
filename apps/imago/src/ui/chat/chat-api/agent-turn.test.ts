import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { UIMessage } from 'ai';
import { ApiError } from '@/api/errors';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { fakeTurnStream } from '@/ui/test-support/fake-turn-stream';
import { chatPaths } from './chat-api';
import { agentTurnBody, stopAgentTurn, streamAgentTurn, userTurnMessage } from './agent-turn';

const TURN = `POST ${chatPaths.turn}`;
const ABORT = `POST ${chatPaths.abort}`;

const turn = {
  agentId: 'p-imago',
  conversationId: 'c1',
  message: userTurnMessage('u1', 'What does the roadmap say?'),
  contextRef: { routeType: 'page', pageId: 'p1', driveId: 'd1' },
} as const;

/** Reads the next snapshot the turn yields. */
const nextOf = async (iterator: AsyncIterator<UIMessage>) => (await iterator.next()).value as UIMessage;

/** The fields a tool part carries for the renderer. */
const toolView = (part: UIMessage['parts'][number]) => {
  const tool = part as { type: string; toolCallId?: string; state?: string; input?: unknown; output?: unknown };
  return { type: tool.type, toolCallId: tool.toolCallId, state: tool.state, input: tool.input, output: tool.output };
};

const textOf = (message: UIMessage | undefined) =>
  message?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');

describe('userTurnMessage()', () => {
  test('parts', () => {
    assert({
      given: 'a prompt',
      should: 'build a user UIMessage with one text part',
      actual: userTurnMessage('u1', 'hello'),
      expected: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    });
  });
});

describe('agentTurnBody()', () => {
  test('page-agent body', () => {
    assert({
      given: 'an agent, a conversation, a prompt and a context ref',
      should: 'name the agent page as chatId and send only the new message (the server loads history)',
      actual: agentTurnBody(turn),
      expected: {
        chatId: 'p-imago',
        conversationId: 'c1',
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What does the roadmap say?' }] }],
        contextRef: { routeType: 'page', pageId: 'p1', driveId: 'd1' },
      },
    });
  });
});

describe('streamAgentTurn()', () => {
  test('the request', async () => {
    const stream = fakeTurnStream();
    const web = fakeWeb({ [TURN]: () => stream.response() });
    const iterator = streamAgentTurn(web.client, turn, { browserSessionId: 'tab-1' })[Symbol.asyncIterator]();
    const first = iterator.next();
    stream.push({ type: 'start', messageId: 'a1' });
    stream.close();
    await first;

    assert({
      given: 'a turn',
      should: 'POST the body to /api/ai/chat with a CSRF token and the tab id, never a global route',
      actual: [
        web.requests.map((request) => `${request.method} ${request.url}`),
        web.requests[0]?.body,
        web.requests[0]?.csrf,
        web.headers[0]?.get('X-Browser-Session-Id'),
        web.headers[0]?.get('X-Stream-Mode'),
      ],
      expected: [[TURN], agentTurnBody(turn), 'tok-1', 'tab-1', null],
    });
  });

  test('deltas as they arrive', async () => {
    const stream = fakeTurnStream();
    const web = fakeWeb({ [TURN]: () => stream.response() });
    const iterator = streamAgentTurn(web.client, turn, { browserSessionId: 'tab-1' })[Symbol.asyncIterator]();

    stream.push({ type: 'start', messageId: 'a1' });
    const started = await nextOf(iterator);
    stream.push({ type: 'text-start', id: 't1' });
    await nextOf(iterator);
    stream.push({ type: 'text-delta', id: 't1', delta: 'The road' });
    const firstDelta = await nextOf(iterator);
    stream.push({ type: 'text-delta', id: 't1', delta: 'map says October.' });
    const secondDelta = await nextOf(iterator);

    assert({
      given: 'text deltas on the stream, one at a time',
      should: 'yield the assistant message with the server id and its text growing per delta',
      actual: [started.id, started.role, textOf(firstDelta), textOf(secondDelta)],
      expected: ['a1', 'assistant', 'The road', 'The roadmap says October.'],
    });
    stream.close();
  });

  test('tool parts as they arrive', async () => {
    const stream = fakeTurnStream();
    const web = fakeWeb({ [TURN]: () => stream.response() });
    const iterator = streamAgentTurn(web.client, turn, { browserSessionId: 'tab-1' })[Symbol.asyncIterator]();

    stream.push({ type: 'start', messageId: 'a1' });
    await nextOf(iterator);
    stream.push({ type: 'tool-input-available', toolCallId: 'call-1', toolName: 'read_page', input: { pageId: 'p1' } });
    const called = await nextOf(iterator);
    stream.push({ type: 'tool-output-available', toolCallId: 'call-1', output: { title: 'Roadmap' } });
    const answered = await nextOf(iterator);

    assert({
      given: 'a tool call, then its result',
      should: 'yield the tool part first with its input, then with its output',
      actual: [called.parts.map(toolView), answered.parts.map(toolView)],
      expected: [
        [{ type: 'tool-read_page', toolCallId: 'call-1', state: 'input-available', input: { pageId: 'p1' }, output: undefined }],
        [{ type: 'tool-read_page', toolCallId: 'call-1', state: 'output-available', input: { pageId: 'p1' }, output: { title: 'Roadmap' } }],
      ],
    });
    stream.close();
  });

  test('the end of the stream', async () => {
    const stream = fakeTurnStream();
    const web = fakeWeb({ [TURN]: () => stream.response() });
    const seen: UIMessage[] = [];
    const reading = (async () => {
      for await (const message of streamAgentTurn(web.client, turn, { browserSessionId: 'tab-1' })) seen.push(message);
    })();
    stream.push({ type: 'start', messageId: 'a1' });
    stream.push({ type: 'text-start', id: 't1' });
    stream.push({ type: 'text-delta', id: 't1', delta: 'Done.' });
    stream.push({ type: 'text-end', id: 't1' });
    stream.push({ type: 'finish' });
    stream.close();
    await reading;

    assert({
      given: 'a finished turn',
      should: 'stop iterating with the whole reply as the last snapshot',
      actual: textOf(seen.at(-1)),
      expected: 'Done.',
    });
  });

  test('an error frame', async () => {
    const stream = fakeTurnStream();
    const web = fakeWeb({ [TURN]: () => stream.response() });
    const seen: UIMessage[] = [];
    const reading = (async () => {
      for await (const message of streamAgentTurn(web.client, turn, { browserSessionId: 'tab-1' })) seen.push(message);
    })().then(
      () => null,
      (error: unknown) => error,
    );
    stream.push({ type: 'start', messageId: 'a1' });
    stream.push({ type: 'text-start', id: 't1' });
    stream.push({ type: 'text-delta', id: 't1', delta: 'Half' });
    stream.push({ type: 'error', errorText: 'Provider overloaded' });
    stream.close();
    const error = await reading;

    assert({
      given: 'the server reporting an error mid-turn',
      should: 'reject with its text, after yielding the partial reply',
      actual: [error instanceof Error ? error.message : error, textOf(seen.at(-1))],
      expected: ['Provider overloaded', 'Half'],
    });
  });

  test('a refused turn', async () => {
    const web = fakeWeb({ [TURN]: () => Response.json({ error: 'Insufficient permissions' }, { status: 403 }) });
    const error = await (async () => {
      for await (const message of streamAgentTurn(web.client, turn, { browserSessionId: 'tab-1' })) void message;
    })().then(
      () => null,
      (rejected: unknown) => rejected,
    );

    assert({
      given: 'the server refusing the turn',
      should: 'reject with its ApiError',
      actual: error instanceof ApiError ? [error.status, error.message] : error,
      expected: [403, 'Insufficient permissions'],
    });
  });
});

describe('stopAgentTurn()', () => {
  test('by message and conversation', async () => {
    const web = fakeWeb({ [ABORT]: () => Response.json({ aborted: true }) });
    const result = await stopAgentTurn(web.client, { conversationId: 'c1', messageId: 'a1' });

    assert({
      given: 'a stop with the reply id known',
      should: 'POST /api/ai/abort naming the message and conversation, with a CSRF token',
      actual: [web.requests.map((r) => [r.method, r.url, r.body, r.csrf]), result],
      expected: [[['POST', chatPaths.abort, { conversationId: 'c1', messageId: 'a1' }, 'tok-1']], { aborted: true }],
    });
  });

  test('before the reply is named', async () => {
    const web = fakeWeb({ [ABORT]: () => Response.json({ aborted: true }) });
    await stopAgentTurn(web.client, { conversationId: 'c1', messageId: null });

    assert({
      given: 'a stop pressed before the start frame',
      should: 'name only the conversation, the one id held from the start',
      actual: web.requests[0]?.body,
      expected: { conversationId: 'c1' },
    });
  });
});
