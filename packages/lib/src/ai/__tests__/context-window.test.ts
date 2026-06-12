import { describe, it, expect } from 'vitest';
import {
  applyPointerCut,
  findUserTurnCut,
  validateTailIntegrity,
  formatSummaryMessage,
  stripNonTextForSummarizer,
  buildModelContext,
} from '../context-window';
import type { CompactionMessage, CompactionState } from '../context-window';

// --- helpers ---

function makeUser(id: string, text: string, createdAt?: Date): CompactionMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
    createdAt: createdAt ?? new Date(`2024-01-01T00:00:${String(parseInt(id.replace(/\D/g, ''), 10)).padStart(2, '0')}Z`),
  };
}

function makeAssistant(id: string, text: string, createdAt?: Date): CompactionMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    createdAt: createdAt ?? new Date(`2024-01-01T00:00:${String(parseInt(id.replace(/\D/g, ''), 10)).padStart(2, '0')}Z`),
  };
}

function makeAssistantWithTool(id: string, toolCallId: string, createdAt?: Date): CompactionMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      { type: 'tool-call', toolCallId, toolName: 'read_page', args: {} },
      { type: 'tool-result', toolCallId, result: 'page content' },
    ],
    createdAt: createdAt ?? new Date(`2024-01-01T00:00:${String(parseInt(id.replace(/\D/g, ''), 10)).padStart(2, '0')}Z`),
  };
}

// 10 messages: u1 a2 u3 a4 u5 a6 u7 a8 u9 a10
const TEN_MSGS: CompactionMessage[] = [
  makeUser('m1', 'hello world'),
  makeAssistant('m2', 'hi there'),
  makeUser('m3', 'how are you?'),
  makeAssistant('m4', 'im fine'),
  makeUser('m5', 'tell me about X'),
  makeAssistant('m6', 'X is great'),
  makeUser('m7', 'what about Y'),
  makeAssistant('m8', 'Y is also good'),
  makeUser('m9', 'and Z?'),
  makeAssistant('m10', 'Z is excellent'),
];

// --- applyPointerCut ---

describe('applyPointerCut', () => {
  it('returns 0 when compaction is null', () => {
    expect(applyPointerCut(TEN_MSGS, null)).toBe(0);
  });

  it('returns index after the matched message id', () => {
    const compaction = {
      compactedUpToMessageId: 'm4',
      compactedUpToCreatedAt: TEN_MSGS[3].createdAt!,
    };
    expect(applyPointerCut(TEN_MSGS, compaction)).toBe(4); // m5 is at index 4
  });

  it('falls back to createdAt when id is missing from messages', () => {
    const cutAt = new Date('2024-01-01T00:00:04Z');
    const compaction = {
      compactedUpToMessageId: 'ghost-id',
      compactedUpToCreatedAt: cutAt,
    };
    // m5 has id 'm5', createdAt '...05Z' which is > cutAt
    // m5 is user, so walk-forward lands on it
    const idx = applyPointerCut(TEN_MSGS, compaction);
    expect(TEN_MSGS[idx].role).toBe('user');
  });

  it('walks forward past non-user messages after createdAt cut', () => {
    // Insert an assistant message right after the pointer so we skip it
    const msgs: CompactionMessage[] = [
      makeUser('u1', 'hi', new Date('2024-01-01T00:00:01Z')),
      makeAssistant('a2', 'hey', new Date('2024-01-01T00:00:02Z')),
      makeAssistant('a3', 'more', new Date('2024-01-01T00:00:03Z')),
      makeUser('u4', 'next', new Date('2024-01-01T00:00:04Z')),
    ];
    const compaction = {
      compactedUpToMessageId: 'ghost',
      compactedUpToCreatedAt: new Date('2024-01-01T00:00:01Z'),
    };
    const idx = applyPointerCut(msgs, compaction);
    expect(msgs[idx].role).toBe('user');
    expect(msgs[idx].id).toBe('u4');
  });

  it('returns messages.length when all messages are at or before createdAt', () => {
    const compaction = {
      compactedUpToMessageId: 'ghost',
      compactedUpToCreatedAt: new Date('2099-01-01T00:00:00Z'),
    };
    expect(applyPointerCut(TEN_MSGS, compaction)).toBe(TEN_MSGS.length);
  });
});

// --- findUserTurnCut ---

describe('findUserTurnCut', () => {
  it('returns 0 when all messages fit within target budget', () => {
    // Very large context window → all fit
    const idx = findUserTurnCut(TEN_MSGS, {
      contextWindow: 10_000_000,
      systemPromptTokens: 0,
      toolTokens: 0,
      summaryTokens: 0,
      targetRatio: 0.4,
    });
    expect(idx).toBe(0);
  });

  it('returns an index pointing at a user-role message', () => {
    // Small context window forces a cut
    const idx = findUserTurnCut(TEN_MSGS, {
      contextWindow: 200,
      systemPromptTokens: 0,
      toolTokens: 0,
      summaryTokens: 0,
      targetRatio: 0.4,
    });
    if (idx > 0 && idx < TEN_MSGS.length) {
      expect(TEN_MSGS[idx].role).toBe('user');
    }
  });

  it('never cuts past the end of the array', () => {
    const idx = findUserTurnCut(TEN_MSGS, {
      contextWindow: 10,
      systemPromptTokens: 5,
      toolTokens: 5,
      summaryTokens: 0,
      targetRatio: 0.4,
    });
    expect(idx).toBeLessThanOrEqual(TEN_MSGS.length);
  });
});

// --- validateTailIntegrity ---

describe('validateTailIntegrity', () => {
  it('passes for empty tail', () => {
    expect(validateTailIntegrity([])).toBe(true);
  });

  it('passes when tail starts with a user message', () => {
    expect(validateTailIntegrity(TEN_MSGS)).toBe(true);
  });

  it('fails when tail starts with assistant', () => {
    const tail = [makeAssistant('a1', 'hi'), makeUser('u2', 'hello')];
    expect(validateTailIntegrity(tail)).toBe(false);
  });

  it('passes with tool-call + tool-result pairs in the same message', () => {
    const msgs: CompactionMessage[] = [
      makeUser('u1', 'do it'),
      makeAssistantWithTool('a2', 'tc1'),
    ];
    expect(validateTailIntegrity(msgs)).toBe(true);
  });

  it('fails when tool-result has no matching tool-call in message', () => {
    const orphan: CompactionMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'tool-result', toolCallId: 'tc-orphan', result: 'data' },
      ],
    };
    expect(validateTailIntegrity([makeUser('u1', 'hi'), orphan])).toBe(false);
  });
});

// --- formatSummaryMessage ---

describe('formatSummaryMessage', () => {
  it('wraps summary in conversation_summary tags', () => {
    const msg = formatSummaryMessage('some summary');
    expect(msg.role).toBe('user');
    const text = msg.parts?.find((p) => p.type === 'text')?.text ?? '';
    expect(text).toContain('<conversation_summary>');
    expect(text).toContain('some summary');
    expect(text).toContain('</conversation_summary>');
  });

  it('includes a retrieval hint', () => {
    const msg = formatSummaryMessage('x');
    const text = msg.parts?.find((p) => p.type === 'text')?.text ?? '';
    expect(text.toLowerCase()).toMatch(/read_conversation|regex_search/);
  });
});

// --- stripNonTextForSummarizer ---

describe('stripNonTextForSummarizer', () => {
  it('returns text parts unchanged', () => {
    const msgs: CompactionMessage[] = [makeUser('u1', 'hello')];
    const result = stripNonTextForSummarizer(msgs);
    expect(result[0].parts).toEqual(msgs[0].parts);
  });

  it('replaces file parts with attachment placeholders', () => {
    const withFile: CompactionMessage = {
      id: 'u1',
      role: 'user',
      parts: [
        { type: 'text', text: 'see this' },
        { type: 'file', filename: 'report.pdf', mediaType: 'application/pdf' },
      ],
    };
    const result = stripNonTextForSummarizer([withFile]);
    const parts = result[0].parts ?? [];
    expect(parts.some((p) => p.type === 'text' && p.text?.includes('[attachment:'))).toBe(true);
    expect(parts.every((p) => p.type !== 'file')).toBe(true);
  });
});

// --- buildModelContext ---

describe('buildModelContext', () => {
  const COMPACTION: CompactionState = {
    summaryVersion: 1,
    compactedUpToMessageId: 'm2',
    compactedUpToCreatedAt: TEN_MSGS[1].createdAt!,
    summary: 'Prior summary.',
    summaryTokens: 10,
    lastCompactedAt: new Date('2024-01-01T00:00:00Z'),
    summarizerModel: 'test-model',
  };

  it('passthrough: returns all messages when well under threshold', () => {
    const result = buildModelContext({
      messages: TEN_MSGS,
      compaction: null,
      model: 'test-model',
      provider: 'openrouter',
      systemPromptTokens: 0,
      toolTokens: 0,
    });
    expect(result.tailMessages.length).toBe(TEN_MSGS.length);
    expect(result.summaryMessage).toBeNull();
    expect(result.compactionPlan).toBeNull();
    expect(result.emergencyTruncated).toBe(false);
  });

  it('applies pointer cut when compaction state is provided', () => {
    const result = buildModelContext({
      messages: TEN_MSGS,
      compaction: COMPACTION,
      model: 'test-model',
      provider: 'openrouter',
      systemPromptTokens: 0,
      toolTokens: 0,
    });
    // tail starts at m3 (index 2), skipping m1/m2
    expect(result.tailMessages[0].id).toBe('m3');
    expect(result.summaryMessage).not.toBeNull();
  });

  it('emits soft compaction plan when over triggerRatio', () => {
    // Fill context by using a tiny context window and lots of messages
    const bigMessages: CompactionMessage[] = [];
    for (let i = 1; i <= 20; i++) {
      bigMessages.push(makeUser(`u${i}`, 'a'.repeat(200)));
      bigMessages.push(makeAssistant(`a${i}`, 'b'.repeat(200)));
    }
    const result = buildModelContext({
      messages: bigMessages,
      compaction: null,
      model: 'gpt-3.5', // small 16k window
      provider: 'openai',
      systemPromptTokens: 0,
      toolTokens: 0,
      config: { triggerRatio: 0.01, hardRatio: 0.95, targetRatio: 0.005, minTailMessages: 2 },
    });
    expect(result.needsCompaction).toBe(true);
    if (result.compactionPlan) {
      expect(result.compactionPlan.reason).toBe('over-soft-threshold');
      // Tail messages returned UNCHANGED (soft = plan for next request)
      expect(result.tailMessages.length).toBe(bigMessages.length);
      expect(result.emergencyTruncated).toBe(false);
    }
  });

  it('truncates inline on hard threshold', () => {
    const bigMessages: CompactionMessage[] = [];
    for (let i = 1; i <= 20; i++) {
      bigMessages.push(makeUser(`u${i}`, 'a'.repeat(300)));
      bigMessages.push(makeAssistant(`a${i}`, 'b'.repeat(300)));
    }
    const result = buildModelContext({
      messages: bigMessages,
      compaction: null,
      model: 'gpt-3.5',
      provider: 'openai',
      systemPromptTokens: 0,
      toolTokens: 0,
      config: { triggerRatio: 0.01, hardRatio: 0.01, targetRatio: 0.005, minTailMessages: 2 },
    });
    expect(result.emergencyTruncated).toBe(true);
    expect(result.tailMessages.length).toBeLessThan(bigMessages.length);
    if (result.tailMessages.length > 0) {
      expect(result.tailMessages[0].role).toBe('user');
    }
  });

  it('emits summary-over-cap plan when summary exceeds maxSummaryTokens', () => {
    const overCapCompaction: CompactionState = {
      ...COMPACTION,
      summaryTokens: 99999,
    };
    const result = buildModelContext({
      messages: TEN_MSGS,
      compaction: overCapCompaction,
      model: 'test-model',
      provider: 'openrouter',
      systemPromptTokens: 0,
      toolTokens: 0,
      config: { maxSummaryTokens: 100 },
    });
    expect(result.compactionPlan?.reason).toBe('summary-over-cap');
  });

  it('never compacts away the active (last) turn', () => {
    const msgs: CompactionMessage[] = [
      makeUser('u1', 'a'.repeat(1000)),
      makeAssistant('a1', 'b'.repeat(1000)),
      makeUser('u2', 'the active turn'),
    ];
    const result = buildModelContext({
      messages: msgs,
      compaction: null,
      model: 'gpt-3.5',
      provider: 'openai',
      systemPromptTokens: 0,
      toolTokens: 0,
      config: { triggerRatio: 0.01, hardRatio: 0.01, targetRatio: 0.005, minTailMessages: 1 },
    });
    const last = result.tailMessages[result.tailMessages.length - 1];
    expect(last?.id).toBe('u2');
  });

  it('respects minTailMessages guard', () => {
    const msgs: CompactionMessage[] = [];
    for (let i = 1; i <= 4; i++) {
      msgs.push(makeUser(`u${i}`, 'a'.repeat(500)));
      msgs.push(makeAssistant(`a${i}`, 'b'.repeat(500)));
    }
    const result = buildModelContext({
      messages: msgs,
      compaction: null,
      model: 'gpt-3.5',
      provider: 'openai',
      systemPromptTokens: 0,
      toolTokens: 0,
      config: { triggerRatio: 0.01, hardRatio: 0.01, targetRatio: 0.005, minTailMessages: 8 },
    });
    // minTailMessages = 8, we only have 8 total → no cut possible
    expect(result.emergencyTruncated).toBe(false);
  });

  it('compaction plan has cutBeforeIndex pointing at a user turn in the original messages', () => {
    const bigMessages: CompactionMessage[] = [];
    for (let i = 1; i <= 12; i++) {
      bigMessages.push(makeUser(`u${i}`, 'a'.repeat(200)));
      bigMessages.push(makeAssistant(`a${i}`, 'b'.repeat(200)));
    }
    const result = buildModelContext({
      messages: bigMessages,
      compaction: null,
      model: 'gpt-3.5',
      provider: 'openai',
      systemPromptTokens: 0,
      toolTokens: 0,
      config: { triggerRatio: 0.01, hardRatio: 0.95, targetRatio: 0.005, minTailMessages: 2 },
    });
    if (result.compactionPlan && result.compactionPlan.cutBeforeIndex < bigMessages.length) {
      expect(bigMessages[result.compactionPlan.cutBeforeIndex].role).toBe('user');
    }
  });
});
