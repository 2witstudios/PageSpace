import { describe, it, expect } from 'vitest';
import {
  computeElisionBoundary,
  elideStaleToolOutputs,
  DEFAULT_ELIDABLE_TOOLS,
  type ElisionOptions,
  type ElisionMessage,
} from '../tool-result-eliding';

// ─── computeElisionBoundary ────────────────────────────────────────────────────

describe('computeElisionBoundary', () => {
  const opts = { keepLastTurns: 4, chunkSize: 8 };

  it('returns 0 when assistantTurnCount is 0', () => {
    expect(computeElisionBoundary(0, opts)).toBe(0);
  });

  it('returns 0 when there are not enough turns to elide', () => {
    // With keepLastTurns=4, need > 4 turns to elide anything
    expect(computeElisionBoundary(4, opts)).toBe(0);
    expect(computeElisionBoundary(3, opts)).toBe(0);
    expect(computeElisionBoundary(1, opts)).toBe(0);
  });

  it('returns a positive boundary at the first chunk crossing', () => {
    // First chunk boundary: once assistantTurnCount > keepLastTurns enough
    // to fill a chunk. With chunkSize=8, keepLastTurns=4: boundary moves at 8
    const boundary = computeElisionBoundary(8, opts);
    expect(boundary).toBeGreaterThan(0);
  });

  it('is chunk-aligned — same input within a chunk window produces byte-identical results', () => {
    // Turns 8 through 15 (second chunk, before it crosses into chunk 3) should give same boundary
    const b8 = computeElisionBoundary(8, opts);
    const b9 = computeElisionBoundary(9, opts);
    const b10 = computeElisionBoundary(10, opts);
    const b11 = computeElisionBoundary(11, opts);
    const b12 = computeElisionBoundary(12, opts);
    const b13 = computeElisionBoundary(13, opts);
    const b14 = computeElisionBoundary(14, opts);
    const b15 = computeElisionBoundary(15, opts);
    // All same chunk — boundary must be identical to ensure stable replayed bytes
    expect(b8).toBe(b9);
    expect(b9).toBe(b10);
    expect(b10).toBe(b11);
    expect(b11).toBe(b12);
    expect(b12).toBe(b13);
    expect(b13).toBe(b14);
    expect(b14).toBe(b15);
  });

  it('advances boundary when a new chunk is crossed', () => {
    const b15 = computeElisionBoundary(15, opts);
    const b16 = computeElisionBoundary(16, opts);
    // 16 crosses into the next chunk, so boundary should advance
    expect(b16).toBeGreaterThanOrEqual(b15);
  });

  it('boundary never exceeds assistantTurnCount minus keepLastTurns', () => {
    for (const n of [5, 8, 12, 20, 40]) {
      const b = computeElisionBoundary(n, opts);
      expect(b).toBeLessThanOrEqual(Math.max(0, n - opts.keepLastTurns));
    }
  });

  it('uses compactionPointer as override when provided', () => {
    // When compactionPointer is present, it directly sets the boundary
    const b = computeElisionBoundary(20, { ...opts, compactionPointer: 5 });
    expect(b).toBe(5);
  });

  it('compactionPointer of 0 returns 0 (no elision)', () => {
    const b = computeElisionBoundary(20, { ...opts, compactionPointer: 0 });
    expect(b).toBe(0);
  });
});

// ─── elideStaleToolOutputs ────────────────────────────────────────────────────

function makeMsg(
  role: 'user' | 'assistant',
  parts: ElisionMessage['parts'],
  id?: string,
): ElisionMessage {
  return { role, parts, id };
}

function toolCallPart(toolCallId: string, toolName: string, args: Record<string, unknown> = {}) {
  return { type: 'tool-call', toolCallId, toolName, args };
}

function toolResultPart(toolCallId: string, toolName: string, result: string) {
  return { type: 'tool-result', toolCallId, toolName, result };
}

function textPart(text: string) {
  return { type: 'text', text };
}

const ELIDABLE = new Set(['read_page', 'regex_search', 'list_pages', 'get_activity', 'web_search']);
const WRITE_TOOLS = new Set(['create_page', 'replace_lines', 'send_channel_message']);

describe('elideStaleToolOutputs', () => {
  const defaultOpts: ElisionOptions = {
    elisionBoundaryTurnIndex: 2,
    minOutputChars: 100,
    elidableTools: ELIDABLE,
    writeTools: WRITE_TOOLS,
  };

  it('does not mutate input messages', () => {
    const msgs: ElisionMessage[] = [
      makeMsg('user', [textPart('hello')]),
      makeMsg('assistant', [
        toolCallPart('c1', 'read_page', { pageId: 'abc' }),
        toolResultPart('c1', 'read_page', 'x'.repeat(200)),
      ]),
      makeMsg('user', [textPart('follow up')]),
    ];
    const original = JSON.stringify(msgs);
    elideStaleToolOutputs(msgs, defaultOpts);
    expect(JSON.stringify(msgs)).toBe(original);
  });

  it('elides large tool results before the boundary turn', () => {
    const bigOutput = 'x'.repeat(2000);
    const msgs: ElisionMessage[] = [
      makeMsg('user', [textPart('q1')]),
      makeMsg('assistant', [
        toolCallPart('c1', 'read_page', { pageId: 'p1' }),
        toolResultPart('c1', 'read_page', bigOutput),
      ], 'msg1'),
      makeMsg('user', [textPart('q2')]),
      makeMsg('assistant', [textPart('answer')], 'msg2'),
      makeMsg('user', [textPart('q3')]),
      // Turn index 2 — last assistant turn; boundary is 2, so only turns < 2 are elided
      makeMsg('assistant', [
        toolCallPart('c2', 'read_page', { pageId: 'p2' }),
        toolResultPart('c2', 'read_page', bigOutput),
      ], 'msg3'),
    ];

    const result = elideStaleToolOutputs(msgs, { ...defaultOpts, elisionBoundaryTurnIndex: 1 });

    // First assistant turn (index 0 of assistant turns) should be elided
    const firstAssistant = result.find(m => m.id === 'msg1');
    expect(firstAssistant).toBeDefined();
    const resultPart = firstAssistant!.parts?.find(p => p.type === 'tool-result');
    expect(typeof resultPart?.result).toBe('string');
    expect((resultPart?.result as string).includes('[output elided')).toBe(true);

    // Last assistant turn should NOT be elided (above boundary)
    const lastAssistant = result.find(m => m.id === 'msg3');
    const lastResultPart = lastAssistant!.parts?.find(p => p.type === 'tool-result');
    expect((lastResultPart?.result as string)).toBe(bigOutput);
  });

  it('preserves tool-call args (inputs stay intact)', () => {
    const msgs: ElisionMessage[] = [
      makeMsg('user', [textPart('q')]),
      makeMsg('assistant', [
        toolCallPart('c1', 'read_page', { pageId: 'p1', lineStart: 5 }),
        toolResultPart('c1', 'read_page', 'x'.repeat(2000)),
      ]),
    ];
    const result = elideStaleToolOutputs(msgs, { ...defaultOpts, elisionBoundaryTurnIndex: 1 });
    const callPart = result[1].parts?.find(p => p.type === 'tool-call');
    expect(callPart?.args).toEqual({ pageId: 'p1', lineStart: 5 });
  });

  it('does not elide outputs below minOutputChars', () => {
    const smallOutput = 'x'.repeat(50);
    const msgs: ElisionMessage[] = [
      makeMsg('user', [textPart('q')]),
      makeMsg('assistant', [
        toolCallPart('c1', 'read_page', { pageId: 'p1' }),
        toolResultPart('c1', 'read_page', smallOutput),
      ]),
      makeMsg('user', [textPart('follow')]),
    ];
    const result = elideStaleToolOutputs(msgs, { ...defaultOpts, elisionBoundaryTurnIndex: 1, minOutputChars: 100 });
    const resultPart = result[1].parts?.find(p => p.type === 'tool-result');
    expect(resultPart?.result).toBe(smallOutput);
  });

  it('does not elide write tool results', () => {
    const bigOutput = 'x'.repeat(2000);
    const msgs: ElisionMessage[] = [
      makeMsg('user', [textPart('q')]),
      makeMsg('assistant', [
        toolCallPart('c1', 'create_page', { title: 'New' }),
        toolResultPart('c1', 'create_page', bigOutput),
      ]),
      makeMsg('user', [textPart('follow')]),
    ];
    const result = elideStaleToolOutputs(msgs, { ...defaultOpts, elisionBoundaryTurnIndex: 1 });
    const resultPart = result[1].parts?.find(p => p.type === 'tool-result');
    expect(resultPart?.result).toBe(bigOutput);
  });

  it('does not elide non-elidable tool outputs', () => {
    const bigOutput = 'x'.repeat(2000);
    const msgs: ElisionMessage[] = [
      makeMsg('user', [textPart('q')]),
      makeMsg('assistant', [
        toolCallPart('c1', 'ask_agent', { agentId: 'x' }),
        toolResultPart('c1', 'ask_agent', bigOutput),
      ]),
      makeMsg('user', [textPart('follow')]),
    ];
    const result = elideStaleToolOutputs(msgs, { ...defaultOpts, elisionBoundaryTurnIndex: 1 });
    const resultPart = result[1].parts?.find(p => p.type === 'tool-result');
    expect(resultPart?.result).toBe(bigOutput);
  });

  it('stub mentions tool name and instructs re-fetch', () => {
    const msgs: ElisionMessage[] = [
      makeMsg('user', [textPart('q')]),
      makeMsg('assistant', [
        toolCallPart('c1', 'read_page', { pageId: 'p1' }),
        toolResultPart('c1', 'read_page', 'x'.repeat(2000)),
      ]),
      makeMsg('user', [textPart('follow')]),
    ];
    const result = elideStaleToolOutputs(msgs, { ...defaultOpts, elisionBoundaryTurnIndex: 1 });
    const resultPart = result[1].parts?.find(p => p.type === 'tool-result');
    const stub = resultPart?.result as string;
    expect(stub).toContain('read_page');
    expect(stub).toContain('regex_search');
  });

  it('does not elide when elisionBoundaryTurnIndex is 0', () => {
    const bigOutput = 'x'.repeat(2000);
    const msgs: ElisionMessage[] = [
      makeMsg('user', [textPart('q')]),
      makeMsg('assistant', [
        toolCallPart('c1', 'read_page'),
        toolResultPart('c1', 'read_page', bigOutput),
      ]),
    ];
    const result = elideStaleToolOutputs(msgs, { ...defaultOpts, elisionBoundaryTurnIndex: 0 });
    const resultPart = result[1].parts?.find(p => p.type === 'tool-result');
    expect(resultPart?.result).toBe(bigOutput);
  });

  it('handles messages with no parts gracefully', () => {
    const msgs: ElisionMessage[] = [
      makeMsg('user', undefined),
      makeMsg('assistant', undefined),
    ];
    expect(() => elideStaleToolOutputs(msgs, defaultOpts)).not.toThrow();
  });

  it('handles non-string result values safely', () => {
    const msgs: ElisionMessage[] = [
      makeMsg('user', [textPart('q')]),
      makeMsg('assistant', [
        toolCallPart('c1', 'read_page'),
        { type: 'tool-result', toolCallId: 'c1', toolName: 'read_page', result: { nested: 'object' } },
      ]),
      makeMsg('user', [textPart('follow')]),
    ];
    // Should not throw and should elide based on JSON.stringify length
    expect(() => elideStaleToolOutputs(msgs, { ...defaultOpts, elisionBoundaryTurnIndex: 1 })).not.toThrow();
  });

  it('chunk-aligned: same assistant turn counts within chunk produce identical output bytes', () => {
    const buildMsgs = (assistantTurns: number): ElisionMessage[] => {
      const result: ElisionMessage[] = [];
      for (let i = 0; i < assistantTurns; i++) {
        result.push(makeMsg('user', [textPart(`q${i}`)]));
        result.push(makeMsg('assistant', [
          toolCallPart(`c${i}`, 'read_page', { pageId: `p${i}` }),
          toolResultPart(`c${i}`, 'read_page', 'x'.repeat(2000)),
        ], `msg${i}`));
      }
      result.push(makeMsg('user', [textPart('final')]));
      return result;
    };

    const opts8 = { ...defaultOpts, elisionBoundaryTurnIndex: computeElisionBoundary(8, { keepLastTurns: 4, chunkSize: 8 }) };
    const opts9 = { ...defaultOpts, elisionBoundaryTurnIndex: computeElisionBoundary(9, { keepLastTurns: 4, chunkSize: 8 }) };
    const opts10 = { ...defaultOpts, elisionBoundaryTurnIndex: computeElisionBoundary(10, { keepLastTurns: 4, chunkSize: 8 }) };

    const r8 = elideStaleToolOutputs(buildMsgs(8), opts8);
    const r9 = elideStaleToolOutputs(buildMsgs(9), opts9);
    const r10 = elideStaleToolOutputs(buildMsgs(10), opts10);

    // First 8 messages in r8, r9, r10 should be identical (same elision boundary)
    // since they're all in the same chunk — the early messages are byte-identical
    for (let i = 0; i < 8 * 2; i++) {
      expect(JSON.stringify(r8[i])).toBe(JSON.stringify(r9[i]));
      expect(JSON.stringify(r9[i])).toBe(JSON.stringify(r10[i]));
    }
  });
});

describe('DEFAULT_ELIDABLE_TOOLS', () => {
  it('does not include execute_tool (may dispatch write-side-effect operations)', () => {
    expect(DEFAULT_ELIDABLE_TOOLS.has('execute_tool')).toBe(false);
  });

  it('includes refetchable read tools', () => {
    expect(DEFAULT_ELIDABLE_TOOLS.has('read_page')).toBe(true);
    expect(DEFAULT_ELIDABLE_TOOLS.has('regex_search')).toBe(true);
    expect(DEFAULT_ELIDABLE_TOOLS.has('web_search')).toBe(true);
  });
});
