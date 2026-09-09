import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  conversationsListHandler,
  conversationsReadHandler,
  parseArgv,
  renderConversation,
  renderConversationsList,
  renderMessageParts,
} from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const LIST_RESULT = {
  conversations: [
    {
      id: 'conv-1',
      title: 'Consult',
      preview: 'What is the plan?',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:02:00.000Z',
      messageCount: 2,
      isShared: false,
      isOwner: true,
      lastMessage: { role: 'assistant', timestamp: '2026-09-01T10:02:00.000Z' },
    },
  ],
  pagination: { page: 0, pageSize: 50, totalCount: 1, totalPages: 1, hasMore: false },
};

const READ_RESULT = {
  conversationId: 'conv-1',
  messageCount: 2,
  messages: [
    {
      id: 'm1',
      role: 'user' as const,
      parts: [{ type: 'text', text: 'What is the plan?' }],
      createdAt: '2026-09-01T10:00:00.000Z',
    },
    {
      id: 'm2',
      role: 'assistant' as const,
      parts: [{ type: 'text', text: 'The plan is...' }],
      createdAt: '2026-09-01T10:02:00.000Z',
    },
  ],
  pagination: { hasMore: false, nextCursor: null, prevCursor: null, limit: 50, direction: 'before' as const },
};

// ---------------------------------------------------------------------------
// The point of these verbs
// ---------------------------------------------------------------------------

/**
 * `agents ask` is a non-idempotent POST that is never auto-retried, and the
 * consult route does not read `request.signal` — so a client-side timeout ends
 * the WAITING, not the work. The consult runs on, bills, and persists its
 * answer. These two verbs are the only way a CLI caller can then reach it;
 * without them `agents ask`'s own timeout advice ("check the agent's
 * conversation history") named a capability that did not exist, and a
 * completed, paid-for answer was unrecoverable.
 */
describe('conversationsListHandler', () => {
  it('lists an agent\'s conversations, newest-first as the route returns them', async () => {
    const stdout = createRecordingSink();
    const list = vi.fn(async () => LIST_RESULT);
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ conversations: { list } }) });

    const code = await conversationsListHandler(ctx, commandIntent(['ag1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(list).toHaveBeenCalledWith({ agentId: 'ag1' });
    expect(stdout.lines.join('')).toContain('conv-1');
  });

  it('emits raw JSON under --json', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ conversations: { list: async () => LIST_RESULT } }) });

    const code = await conversationsListHandler(ctx, commandIntent(['ag1', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(LIST_RESULT);
  });

  it('exits 2 without an agent id', async () => {
    const ctx = createFakeContext({ sdk: fakeSdk({ conversations: { list: async () => LIST_RESULT } }) });
    expect(await conversationsListHandler(ctx, commandIntent([]))).toBe(EXIT_USAGE_ERROR);
  });

  it('exits 1 and surfaces the server error verbatim', async () => {
    const stderr = createRecordingSink();
    const list = vi.fn(async () => {
      throw new Error('Agent not found');
    });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ conversations: { list } }) });

    expect(await conversationsListHandler(ctx, commandIntent(['ag1']))).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Agent not found');
  });
});

describe('conversationsReadHandler', () => {
  it('reads back the answer a timed-out ask left behind', async () => {
    const stdout = createRecordingSink();
    const read = vi.fn(async () => READ_RESULT);
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ conversations: { read } }) });

    const code = await conversationsReadHandler(ctx, commandIntent(['ag1', 'conv-1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(read).toHaveBeenCalledWith({ agentId: 'ag1', conversationId: 'conv-1' });
    expect(stdout.lines.join('')).toContain('The plan is...');
  });

  it('exits 2 without a conversation id', async () => {
    const ctx = createFakeContext({ sdk: fakeSdk({ conversations: { read: async () => READ_RESULT } }) });
    expect(await conversationsReadHandler(ctx, commandIntent(['ag1']))).toBe(EXIT_USAGE_ERROR);
  });
});

// ---------------------------------------------------------------------------
// Rendering — pure
// ---------------------------------------------------------------------------

describe('renderConversationsList / renderConversation', () => {
  it('says so plainly when there is nothing', () => {
    expect(renderConversationsList({ ...LIST_RESULT, conversations: [] })).toBe('No conversations.\n');
    expect(renderConversation({ ...READ_RESULT, messages: [] })).toBe('No messages.\n');
  });

  it('renders each message with its role', () => {
    const rendered = renderConversation(READ_RESULT);
    expect(rendered).toContain('user (2026-09-01T10:00:00.000Z):');
    expect(rendered).toContain('assistant (2026-09-01T10:02:00.000Z):');
  });
});

/**
 * Messages are canonical `parts` arrays (project law), not a flat `content`
 * string. A consult answer is text, but a conversation that ran tools also
 * carries `tool-*` parts — dropping them would render a message that was
 * entirely tool activity as blank, which reads as "the agent said nothing"
 * when in fact it did a great deal.
 */
describe('renderMessageParts', () => {
  it('joins multiple text parts', () => {
    const text = renderMessageParts({
      id: 'm',
      role: 'assistant',
      parts: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
      createdAt: 'now',
    });
    expect(text).toBe('first\nsecond');
  });

  it('labels a tool part rather than dropping it', () => {
    const text = renderMessageParts({
      id: 'm',
      role: 'assistant',
      parts: [{ type: 'tool-read_page', toolName: 'read_page' }],
      createdAt: 'now',
    });
    expect(text).toBe('[tool: read_page]');
  });

  it('labels a file part rather than dropping it', () => {
    const text = renderMessageParts({
      id: 'm',
      role: 'user',
      parts: [{ type: 'file', filename: 'notes.md', mediaType: 'text/markdown' }],
      createdAt: 'now',
    });
    expect(text).toBe('[file: notes.md]');
  });

  it('renders a tool-only message as non-empty', () => {
    const text = renderMessageParts({
      id: 'm',
      role: 'assistant',
      parts: [{ type: 'step-start' }, { type: 'tool-search', toolName: 'search' }],
      createdAt: 'now',
    });
    expect(text.length).toBeGreaterThan(0);
  });

  /**
   * The `parts` union grows server-side. A renderer that silently drops what it
   * does not recognize gets quieter over time without anyone noticing, so an
   * unknown part is NAMED rather than skipped — including one this CLI could
   * not have known about when it was written.
   */
  it.each([
    ['a data part', 'data-citation'],
    ['a part type added after this was written', 'reasoning'],
  ])('names %s rather than dropping it', (_label, type) => {
    const text = renderMessageParts({ id: 'm', role: 'assistant', parts: [{ type }], createdAt: 'now' });
    expect(text).toBe(`[${type}]`);
  });

  it('renders a message made ONLY of unknown parts as non-empty', () => {
    const text = renderMessageParts({
      id: 'm',
      role: 'assistant',
      parts: [{ type: 'data-citation' }],
      createdAt: 'now',
    });
    expect(text.length).toBeGreaterThan(0);
  });

  /**
   * The one deliberate exception: `step-start` is a structural marker with no
   * content, so labelling it would add noise to every transcript. Asserted so
   * the exception stays a decision rather than becoming an accident.
   */
  it('stays silent for a structural step-start marker', () => {
    const text = renderMessageParts({ id: 'm', role: 'assistant', parts: [{ type: 'step-start' }], createdAt: 'now' });
    expect(text).toBe('');
  });
});
