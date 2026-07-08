import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';

// --- DB mock -----------------------------------------------------------
// A minimal chainable select() that supports both .where().limit() (targeted
// lookup by messageId) and .where().orderBy().limit() (dismissal's "last
// assistant message" scan). Each test seeds the row(s) it wants returned.
let selectRows: unknown[] = [];
function makeSelectChain() {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(selectRows)),
  };
  return chain;
}

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => makeSelectChain()),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({ chatMessages: {} }));
vi.mock('@pagespace/db/schema/conversations', () => ({ messages: {} }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), info: vi.fn() } },
}));

// --- message-utils mock -------------------------------------------------
// convertDbMessageToUIMessage / convertGlobalAssistantMessageToUIMessage are
// stubbed to hand back the exact UIMessage the test seeded on the row (via
// `__uiMessage`), so these tests exercise the MERGE logic in ask-user-resume.ts
// against a known-shape message rather than the unrelated structured-content
// reconstruction pipeline (covered separately by message-utils' own tests).
// extractMessageContent/extractToolCalls/extractToolResults run for REAL so the
// persistence payload built from the merged message is genuinely exercised.
// vi.hoisted: vi.mock factories are hoisted above all other top-level code, so
// these mocks must be created through vi.hoisted to be visible inside them.
const { saveMessageToDatabase, saveGlobalAssistantMessageToDatabase } = vi.hoisted(() => ({
  saveMessageToDatabase: vi.fn().mockResolvedValue(undefined),
  saveGlobalAssistantMessageToDatabase: vi.fn().mockResolvedValue(undefined),
}));

// Keyed by row.id — set per-test via `uiMessagesById` below — rather than
// piggy-backing extra fields onto the DatabaseMessage-shaped object the real
// code constructs (which only carries fields convertDbMessageToUIMessage's
// real signature declares). vi.hoisted: must exist before the vi.mock
// factory below runs (imports, and therefore mock factories, execute before
// ordinary top-level `const`s in this file).
const uiMessagesById = vi.hoisted(() => new Map<string, UIMessage>());

vi.mock('@/lib/ai/core/message-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../message-utils')>();
  return {
    ...actual,
    convertDbMessageToUIMessage: vi.fn(async (row: { id: string }) => uiMessagesById.get(row.id)),
    convertGlobalAssistantMessageToUIMessage: vi.fn(async (row: { id: string }) => uiMessagesById.get(row.id)),
    saveMessageToDatabase,
    saveGlobalAssistantMessageToDatabase,
  };
});

import {
  extractClientAskUserResults,
  applyAskUserResultsToPageMessage,
  dismissPendingAskUserForPageConversation,
} from '../ask-user-resume';

const pendingPart = (toolCallId: string): UIMessage['parts'][number] => ({
  type: 'tool-ask_user',
  toolCallId,
  state: 'input-available',
  input: { questions: [{ header: 'Auth', question: 'Which?', options: [{ label: 'OAuth' }, { label: 'API key' }] }] },
} as UIMessage['parts'][number]);

const answeredPart = (toolCallId: string): UIMessage['parts'][number] => ({
  type: 'tool-ask_user',
  toolCallId,
  state: 'output-available',
  input: { questions: [{ header: 'Auth', question: 'Which?', options: [{ label: 'OAuth' }, { label: 'API key' }] }] },
  output: { answers: [{ header: 'Auth', question: 'Which?', selectedLabel: 'OAuth' }] },
} as UIMessage['parts'][number]);

const dbRow = (parts: UIMessage['parts'], overrides: Record<string, unknown> = {}) => {
  const id = (overrides.id as string) ?? 'msg-1';
  const role = (overrides.role as string) ?? 'assistant';
  uiMessagesById.set(id, { id, role: role as UIMessage['role'], parts });
  return {
    id,
    pageId: 'page-1',
    conversationId: 'conv-1',
    userId: null,
    role,
    content: '',
    toolCalls: null,
    toolResults: null,
    createdAt: new Date('2026-01-01'),
    isActive: true,
    editedAt: null,
    messageType: 'standard' as const,
    ...overrides,
  };
};

beforeEach(() => {
  selectRows = [];
  uiMessagesById.clear();
  saveMessageToDatabase.mockClear();
  saveGlobalAssistantMessageToDatabase.mockClear();
});

describe('extractClientAskUserResults', () => {
  it('extracts output-available ask_user parts from a trailing assistant message', () => {
    const results = extractClientAskUserResults({
      id: 'm1',
      role: 'assistant',
      parts: [answeredPart('q1')],
    } as UIMessage);
    expect(results).toEqual([{ toolCallId: 'q1', output: { answers: [{ header: 'Auth', question: 'Which?', selectedLabel: 'OAuth' }] } }]);
  });

  it('returns empty for a non-assistant message', () => {
    expect(extractClientAskUserResults({ id: 'm1', role: 'user', parts: [] } as UIMessage)).toEqual([]);
  });

  it('returns empty when the ask_user part has no output yet', () => {
    const results = extractClientAskUserResults({
      id: 'm1',
      role: 'assistant',
      parts: [pendingPart('q1')],
    } as UIMessage);
    expect(results).toEqual([]);
  });
});

describe('applyAskUserResultsToPageMessage', () => {
  it('merges a valid answer into the pending part and persists an update', async () => {
    selectRows = [dbRow([pendingPart('q1')])];

    const result = await applyAskUserResultsToPageMessage({
      messageId: 'msg-1',
      pageId: 'page-1',
      conversationId: 'conv-1',
      results: [{ toolCallId: 'q1', output: { answers: [{ header: 'Auth', question: 'Which?', selectedLabel: 'OAuth' }] } }],
    });

    expect(result).toEqual({ merged: true });
    expect(saveMessageToDatabase).toHaveBeenCalledTimes(1);
    const call = saveMessageToDatabase.mock.calls[0][0];
    expect(call.messageId).toBe('msg-1');
    expect(call.role).toBe('assistant');
    const savedPart = call.uiMessage.parts.find((p: { toolCallId: string }) => p.toolCallId === 'q1');
    expect(savedPart.state).toBe('output-available');
    expect(savedPart.output).toEqual({ answers: [{ header: 'Auth', question: 'Which?', selectedLabel: 'OAuth' }] });
  });

  it('is idempotent: skips a toolCallId that is already answered', async () => {
    selectRows = [dbRow([answeredPart('q1')])];

    const result = await applyAskUserResultsToPageMessage({
      messageId: 'msg-1',
      pageId: 'page-1',
      conversationId: 'conv-1',
      results: [{ toolCallId: 'q1', output: { answers: [{ header: 'Auth', question: 'Which?', selectedLabel: 'API key' }] } }],
    });

    expect(result).toEqual({ merged: false });
    expect(saveMessageToDatabase).not.toHaveBeenCalled();
  });

  it('rejects an unknown toolCallId — no matching part to merge into', async () => {
    selectRows = [dbRow([pendingPart('q1')])];

    const result = await applyAskUserResultsToPageMessage({
      messageId: 'msg-1',
      pageId: 'page-1',
      conversationId: 'conv-1',
      results: [{ toolCallId: 'does-not-exist', output: { answers: [] } }],
    });

    expect(result).toEqual({ merged: false });
    expect(saveMessageToDatabase).not.toHaveBeenCalled();
  });

  it('rejects output that fails schema validation and does not persist it', async () => {
    selectRows = [dbRow([pendingPart('q1')])];

    const result = await applyAskUserResultsToPageMessage({
      messageId: 'msg-1',
      pageId: 'page-1',
      conversationId: 'conv-1',
      results: [{ toolCallId: 'q1', output: { junk: 'not a valid answer shape' } }],
    });

    expect(result).toEqual({ merged: false });
    expect(saveMessageToDatabase).not.toHaveBeenCalled();
  });

  it('no-ops when the row is not an assistant message', async () => {
    selectRows = [dbRow([pendingPart('q1')], { role: 'user' })];

    const result = await applyAskUserResultsToPageMessage({
      messageId: 'msg-1',
      pageId: 'page-1',
      conversationId: 'conv-1',
      results: [{ toolCallId: 'q1', output: { answers: [] } }],
    });

    expect(result).toEqual({ merged: false });
    expect(saveMessageToDatabase).not.toHaveBeenCalled();
  });

  it('no-ops when no row is found', async () => {
    selectRows = [];

    const result = await applyAskUserResultsToPageMessage({
      messageId: 'missing',
      pageId: 'page-1',
      conversationId: 'conv-1',
      results: [{ toolCallId: 'q1', output: { answers: [] } }],
    });

    expect(result).toEqual({ merged: false });
    expect(saveMessageToDatabase).not.toHaveBeenCalled();
  });
});

describe('dismissPendingAskUserForPageConversation', () => {
  it('synthesizes a dismissed result onto a still-pending ask_user call', async () => {
    selectRows = [dbRow([pendingPart('q1')])];

    await dismissPendingAskUserForPageConversation({ pageId: 'page-1', conversationId: 'conv-1' });

    expect(saveMessageToDatabase).toHaveBeenCalledTimes(1);
    const call = saveMessageToDatabase.mock.calls[0][0];
    const savedPart = call.uiMessage.parts.find((p: { toolCallId: string }) => p.toolCallId === 'q1');
    expect(savedPart.state).toBe('output-available');
    expect(savedPart.output).toEqual({ dismissed: true, reason: 'User replied in chat instead of selecting an option.' });
  });

  it('does nothing when there is no pending ask_user call', async () => {
    selectRows = [dbRow([answeredPart('q1')])];

    await dismissPendingAskUserForPageConversation({ pageId: 'page-1', conversationId: 'conv-1' });

    expect(saveMessageToDatabase).not.toHaveBeenCalled();
  });

  it('does nothing when no assistant message exists yet', async () => {
    selectRows = [];

    await dismissPendingAskUserForPageConversation({ pageId: 'page-1', conversationId: 'conv-1' });

    expect(saveMessageToDatabase).not.toHaveBeenCalled();
  });
});
