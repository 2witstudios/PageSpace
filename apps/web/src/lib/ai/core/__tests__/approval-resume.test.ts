import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';

// --- DB mock ------------------------------------------------------------
// Each `.limit()` resolves the next queued result (falling back to the last),
// so fetchById / fetchLastMessageId / fetchLastAssistant can be scripted
// independently within one test.
let limitQueue: unknown[][] = [];
function nextLimitResult(): unknown[] {
  if (limitQueue.length === 0) return [];
  return limitQueue.length === 1 ? limitQueue[0] : (limitQueue.shift() as unknown[]);
}
function makeSelectChain() {
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(nextLimitResult())),
  };
  return chain;
}
vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn(() => makeSelectChain()) } }));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(), ne: vi.fn(), and: vi.fn(), or: vi.fn(), desc: vi.fn(), sql: vi.fn(),
  exists: vi.fn(), lt: vi.fn(), gt: vi.fn(), isNull: vi.fn(), isNotNull: vi.fn(), inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/conversations', () => ({
  messages: { id: 'messages.id', pageId: 'messages.pageId' },
  conversations: { type: 'conversations.type', contextId: 'conversations.contextId', id: 'conversations.id' },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), info: vi.fn() } },
}));

const { saveGlobal, claimDecision, addGrant, markExecuted, claimStale, recordOutcome } = vi.hoisted(() => ({
  saveGlobal: vi.fn().mockResolvedValue(undefined),
  claimDecision: vi.fn(),
  addGrant: vi.fn().mockResolvedValue(undefined),
  markExecuted: vi.fn().mockResolvedValue(undefined),
  claimStale: vi.fn(),
  recordOutcome: vi.fn(),
}));
const uiMessagesById = vi.hoisted(() => new Map<string, UIMessage>());

vi.mock('@/lib/ai/core/message-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../message-utils')>();
  return {
    ...actual,
    convertDbMessageToUIMessage: vi.fn(async (row: { id: string }) => uiMessagesById.get(row.id)),
    convertGlobalAssistantMessageToUIMessage: vi.fn(async (row: { id: string }) => uiMessagesById.get(row.id)),
  };
});
vi.mock('@/lib/repositories/message-repository', () => ({
  messageRepository: {
    savePageMessage: vi.fn(),
    saveGlobalMessage: (args: Record<string, unknown>) => saveGlobal(args).then(() => ({ saved: true, rev: 1 })),
  },
}));
vi.mock('@/lib/repositories/tool-approval-repository', () => ({
  toolApprovalRepository: { claimDecision, addGrant, markExecuted, claimStale, recordOutcome },
}));

import {
  extractClientToolApprovalResponses,
  applyToolApprovalResponsesToGlobalMessage,
  dismissPendingToolApprovalsForGlobalConversation,
  recordApprovedToolOutcomeOnGlobalMessage,
  DISMISSED_APPROVAL_REASON,
  STALE_APPROVAL_REASON,
} from '../approval-resume';

type Part = UIMessage['parts'][number];
const requested = (toolCallId: string, approvalId: string, over: Record<string, unknown> = {}): Part =>
  ({ type: 'tool-trash_page', toolCallId, toolName: 'trash_page', state: 'approval-requested', input: { pageId: 'p1' }, approval: { id: approvalId }, ...over }) as unknown as Part;
const responded = (toolCallId: string, approvalId: string, approved: boolean, reason?: string): Part =>
  ({ type: 'tool-trash_page', toolCallId, toolName: 'trash_page', state: 'approval-responded', input: { pageId: 'p1' }, approval: { id: approvalId, approved, ...(reason ? { reason } : {}) } }) as unknown as Part;

const row = (parts: Part[], id = 'msg-1') => {
  uiMessagesById.set(id, { id, role: 'assistant', parts });
  return { id, conversationId: 'conv-1', userId: 'user-1', role: 'assistant', content: '', toolCalls: null, toolResults: null, createdAt: new Date('2026-01-01'), isActive: true, editedAt: null, messageType: 'standard', status: 'complete' };
};
const savedParts = () => (saveGlobal.mock.calls.at(-1)?.[0] as { uiMessage: UIMessage }).uiMessage.parts as Array<Record<string, unknown>>;
const base = { messageId: 'msg-1', conversationId: 'conv-1', userId: 'user-1' };

beforeEach(() => {
  limitQueue = [];
  uiMessagesById.clear();
  saveGlobal.mockClear();
  addGrant.mockClear();
  markExecuted.mockClear();
  claimDecision.mockReset();
  claimDecision.mockImplementation(async ({ approvalId }: { approvalId: string }) => ({ approvalId }));
  claimStale.mockReset();
  claimStale.mockResolvedValue(true);
  recordOutcome.mockReset();
  recordOutcome.mockResolvedValue(true);
});

describe('extractClientToolApprovalResponses', () => {
  it('keeps only toolCallId/approvalId/approved/reason from approval-responded parts and ignores everything else', () => {
    const out = extractClientToolApprovalResponses({
      id: 'm', role: 'assistant',
      parts: [
        responded('tc1', 'ap1', true),
        responded('tc2', 'ap2', false, 'keep it'),
        requested('tc3', 'ap3'),
        { type: 'text', text: 'hi' } as Part,
        { type: 'tool-x', toolCallId: 'tc4', state: 'approval-responded', approval: { id: 'ap4' } } as unknown as Part,
      ],
    } as UIMessage);
    expect(out).toEqual([
      { toolCallId: 'tc1', approvalId: 'ap1', approved: true },
      { toolCallId: 'tc2', approvalId: 'ap2', approved: false, reason: 'keep it' },
    ]);
  });

  it('returns nothing for a user message or a missing message', () => {
    expect(extractClientToolApprovalResponses({ id: 'm', role: 'user', parts: [responded('tc1', 'ap1', true)] } as UIMessage)).toEqual([]);
    expect(extractClientToolApprovalResponses(undefined)).toEqual([]);
  });
});

describe('applyToolApprovalResponses', () => {
  it('an approval on the newest message claims the decision, flips the part to approval-responded, and returns the call to execute', async () => {
    const r = row([requested('tc1', 'ap1')]);
    limitQueue = [[r], [{ id: 'msg-1' }]];
    const result = await applyToolApprovalResponsesToGlobalMessage({ ...base, responses: [{ toolCallId: 'tc1', approvalId: 'ap1', approved: true }] });
    expect(result).toEqual({ kind: 'applied', approved: [{ approvalId: 'ap1', toolCallId: 'tc1', toolName: 'trash_page', input: { pageId: 'p1' } }], denied: 0 });
    expect(claimDecision).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'ap1', approved: true, scope: 'once', toolName: 'trash_page', userId: 'user-1' }));
    expect(savedParts()[0]).toMatchObject({ state: 'approval-responded', approval: { id: 'ap1', approved: true } });
    expect(addGrant).not.toHaveBeenCalled();
  });

  it('a denial flips the part to output-denied with the reason and records the outcome', async () => {
    const r = row([requested('tc1', 'ap1')]);
    limitQueue = [[r], [{ id: 'msg-1' }]];
    const result = await applyToolApprovalResponsesToGlobalMessage({ ...base, responses: [{ toolCallId: 'tc1', approvalId: 'ap1', approved: false, reason: 'not now' }] });
    expect(result).toEqual({ kind: 'applied', approved: [], denied: 1 });
    expect(savedParts()[0]).toMatchObject({ state: 'output-denied', approval: { id: 'ap1', approved: false, reason: 'not now' } });
    expect(markExecuted).toHaveBeenCalledWith('ap1', 'denied');
  });

  it('writes a grant for conversation / always scopes, on the EFFECTIVE tool name through execute_tool', async () => {
    const dispatched = requested('tc1', 'ap1', { type: 'tool-execute_tool', toolName: 'execute_tool', input: { tool_name: 'trash_page', parameters: { pageId: 'p1' } } });
    const r = row([dispatched, requested('tc2', 'ap2')]);
    limitQueue = [[r], [{ id: 'msg-1' }]];
    const result = await applyToolApprovalResponsesToGlobalMessage({
      ...base,
      responses: [{ toolCallId: 'tc1', approvalId: 'ap1', approved: true }, { toolCallId: 'tc2', approvalId: 'ap2', approved: true }],
      scopes: { ap1: 'always', ap2: 'conversation' },
    });
    expect(result.kind).toBe('applied');
    expect(addGrant).toHaveBeenCalledWith({ userId: 'user-1', toolName: 'trash_page', conversationId: null });
    expect(addGrant).toHaveBeenCalledWith({ userId: 'user-1', toolName: 'trash_page', conversationId: 'conv-1' });
    expect((result as { approved: unknown[] }).approved).toHaveLength(2);
  });

  it('rejects a response whose approval id does not match the persisted one (nothing claimed, nothing saved)', async () => {
    const r = row([requested('tc1', 'ap1')]);
    limitQueue = [[r], [{ id: 'msg-1' }]];
    const result = await applyToolApprovalResponsesToGlobalMessage({ ...base, responses: [{ toolCallId: 'tc1', approvalId: 'forged', approved: true }] });
    expect(result).toEqual({ kind: 'already_resolved' });
    expect(claimDecision).not.toHaveBeenCalled();
    expect(saveGlobal).not.toHaveBeenCalled();
  });

  it('refuses a stale card: the row is not the newest message, so nothing executes', async () => {
    const r = row([requested('tc1', 'ap1')]);
    limitQueue = [[r], [{ id: 'msg-newer' }]];
    const result = await applyToolApprovalResponsesToGlobalMessage({ ...base, responses: [{ toolCallId: 'tc1', approvalId: 'ap1', approved: true }] });
    expect(result).toEqual({ kind: 'stale' });
    expect(claimDecision).not.toHaveBeenCalled();
  });

  it('loses the claim (double submit / other tab): reports already_resolved and writes nothing', async () => {
    claimDecision.mockResolvedValue(null);
    const r = row([requested('tc1', 'ap1')]);
    limitQueue = [[r], [{ id: 'msg-1' }]];
    const result = await applyToolApprovalResponsesToGlobalMessage({ ...base, responses: [{ toolCallId: 'tc1', approvalId: 'ap1', approved: true }] });
    expect(result).toEqual({ kind: 'already_resolved' });
    expect(saveGlobal).not.toHaveBeenCalled();
  });

  it('a part that is no longer approval-requested is not touched', async () => {
    const r = row([responded('tc1', 'ap1', true)]);
    limitQueue = [[r], [{ id: 'msg-1' }]];
    const result = await applyToolApprovalResponsesToGlobalMessage({ ...base, responses: [{ toolCallId: 'tc1', approvalId: 'ap1', approved: true }] });
    expect(result).toEqual({ kind: 'already_resolved' });
    expect(claimDecision).not.toHaveBeenCalled();
  });

  it('returns not_found when the row does not exist', async () => {
    limitQueue = [[]];
    expect(await applyToolApprovalResponsesToGlobalMessage({ ...base, responses: [{ toolCallId: 'tc1', approvalId: 'ap1', approved: true }] })).toEqual({ kind: 'not_found' });
  });
});

describe('dismissPendingToolApprovals', () => {
  it('a typed message denies every pending request (claimed) and closes an approved-but-never-run part as stale', async () => {
    const r = row([requested('tc1', 'ap1'), responded('tc2', 'ap2', true), { type: 'text', text: 'x' } as Part]);
    limitQueue = [[r]];
    const result = await dismissPendingToolApprovalsForGlobalConversation({ conversationId: 'conv-1', userId: 'user-1' });
    expect(result).toEqual({ denied: 2 });
    expect(claimDecision).toHaveBeenCalledTimes(1);
    expect(claimDecision).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'ap1', approved: false, reason: DISMISSED_APPROVAL_REASON }));
    const parts = savedParts();
    expect(parts[0]).toMatchObject({ state: 'output-denied', approval: { id: 'ap1', approved: false, reason: DISMISSED_APPROVAL_REASON } });
    expect(parts[1]).toMatchObject({ state: 'output-denied', approval: { id: 'ap2', approved: false, reason: STALE_APPROVAL_REASON } });
    expect(markExecuted).toHaveBeenCalledWith('ap1', 'denied');
    expect(claimStale).toHaveBeenCalledWith('ap2');
    expect(markExecuted).not.toHaveBeenCalledWith('ap2', expect.anything());
  });

  it('an approved part whose execution has STARTED (stale claim lost) is left alone for the running turn to record', async () => {
    claimStale.mockResolvedValue(false);
    const r = row([responded('tc2', 'ap2', true)]);
    limitQueue = [[r]];
    expect(await dismissPendingToolApprovalsForGlobalConversation({ conversationId: 'conv-1', userId: 'user-1' })).toEqual({ denied: 0 });
    expect(saveGlobal).not.toHaveBeenCalled();
    expect(markExecuted).not.toHaveBeenCalled();
  });

  it('a pending request already claimed elsewhere (approve raced the typed message) is left for that winner', async () => {
    claimDecision.mockResolvedValue(null);
    const r = row([requested('tc1', 'ap1')]);
    limitQueue = [[r]];
    expect(await dismissPendingToolApprovalsForGlobalConversation({ conversationId: 'conv-1', userId: 'user-1' })).toEqual({ denied: 0 });
    expect(saveGlobal).not.toHaveBeenCalled();
  });

  it('does nothing when the last assistant message has no approval parts', async () => {
    const r = row([{ type: 'text', text: 'done' } as Part]);
    limitQueue = [[r]];
    expect(await dismissPendingToolApprovalsForGlobalConversation({ conversationId: 'conv-1', userId: 'user-1' })).toEqual({ denied: 0 });
    expect(saveGlobal).not.toHaveBeenCalled();
  });
});

describe('recordApprovedToolOutcome', () => {
  it('writes output-available onto the responded part and marks the decision ok', async () => {
    const r = row([responded('tc1', 'ap1', true)]);
    limitQueue = [[r]];
    const result = await recordApprovedToolOutcomeOnGlobalMessage({ conversationId: 'conv-1', messageId: 'msg-1', toolCallId: 'tc1', approvalId: 'ap1', outcome: { ok: true, output: { trashed: true } } });
    expect(result.recorded).toBe(true);
    expect(savedParts()[0]).toMatchObject({ state: 'output-available', output: { trashed: true }, approval: { id: 'ap1', approved: true } });
    expect(recordOutcome).toHaveBeenCalledWith('ap1', 'ok');
    expect(markExecuted).not.toHaveBeenCalled();
  });

  it('loses the outcome claim (nothing running or stale under that id): records nothing and writes nothing', async () => {
    recordOutcome.mockResolvedValue(false);
    const r = row([responded('tc1', 'ap1', true)]);
    limitQueue = [[r]];
    const result = await recordApprovedToolOutcomeOnGlobalMessage({ conversationId: 'conv-1', messageId: 'msg-1', toolCallId: 'tc1', approvalId: 'ap1', outcome: { ok: true, output: 1 } });
    expect(result.recorded).toBe(false);
    expect(saveGlobal).not.toHaveBeenCalled();
  });

  it('truth wins over stale: a part closed as stale while the call was still running is rewritten with the real result', async () => {
    const staleClosed = { ...(responded('tc1', 'ap1', true) as unknown as Record<string, unknown>), state: 'output-denied', approval: { id: 'ap1', approved: false, reason: STALE_APPROVAL_REASON } } as unknown as Part;
    const r = row([staleClosed]);
    limitQueue = [[r]];
    const result = await recordApprovedToolOutcomeOnGlobalMessage({ conversationId: 'conv-1', messageId: 'msg-1', toolCallId: 'tc1', approvalId: 'ap1', outcome: { ok: true, output: { trashed: true } } });
    expect(result.recorded).toBe(true);
    expect(savedParts()[0]).toMatchObject({ state: 'output-available', output: { trashed: true }, approval: { id: 'ap1', approved: true } });
    expect(recordOutcome).toHaveBeenCalledWith('ap1', 'ok');
  });

  it('writes output-error with the message and marks the decision error', async () => {
    const r = row([responded('tc1', 'ap1', true)]);
    limitQueue = [[r]];
    await recordApprovedToolOutcomeOnGlobalMessage({ conversationId: 'conv-1', messageId: 'msg-1', toolCallId: 'tc1', approvalId: 'ap1', outcome: { ok: false, errorText: 'boom' } });
    expect(savedParts()[0]).toMatchObject({ state: 'output-error', errorText: 'boom' });
    expect(recordOutcome).toHaveBeenCalledWith('ap1', 'error');
  });

  it('is a no-op for a part that is not in approval-responded (second report, or never approved)', async () => {
    const r = row([requested('tc1', 'ap1')]);
    limitQueue = [[r]];
    const result = await recordApprovedToolOutcomeOnGlobalMessage({ conversationId: 'conv-1', messageId: 'msg-1', toolCallId: 'tc1', approvalId: 'ap1', outcome: { ok: true, output: 1 } });
    expect(result.recorded).toBe(false);
    expect(saveGlobal).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
  });
});
