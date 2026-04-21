import { describe, it, expect, beforeEach, vi } from 'vitest';

type StructuredContent = {
  textParts: string[];
  partsOrder: Array<{ index: number; type: string; toolCallId?: string }>;
  originalContent: string;
};

type ToolCallOut = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  state: string;
};

type ToolResultOut = {
  toolCallId: string;
  toolName: string;
  output: unknown;
  state: string;
};

const { testState } = vi.hoisted(() => {
  const state = {
    agentRun: null as Record<string, unknown> | null,
    conversation: null as Record<string, unknown> | null,
    events: [] as Array<{ seq: number; type: string; payload: unknown }>,
    insertedValues: null as Record<string, unknown> | null,
    conflictUpdateSet: null as Record<string, unknown> | null,
  };
  return { testState: state };
});

vi.mock('@pagespace/db', () => {
  const chainable = <T>(resolvedValue: T) => {
    const obj: Record<string, unknown> = {};
    const self = obj as unknown as Promise<T> & Record<string, (...args: unknown[]) => unknown>;
    obj.from = () => self;
    obj.where = () => self;
    obj.orderBy = () => Promise.resolve(resolvedValue);
    obj.then = (resolve: (v: T) => unknown) => Promise.resolve(resolvedValue).then(resolve);
    return self;
  };

  return {
    db: {
      query: {
        agentRuns: {
          findFirst: vi.fn(async () => testState.agentRun),
        },
        conversations: {
          findFirst: vi.fn(async () => testState.conversation),
        },
      },
      select: vi.fn(() => chainable(testState.events)),
      insert: vi.fn(() => ({
        values: (v: Record<string, unknown>) => {
          testState.insertedValues = v;
          return {
            onConflictDoUpdate: (opts: { set: Record<string, unknown> }) => {
              testState.conflictUpdateSet = opts.set;
              return Promise.resolve();
            },
          };
        },
      })),
    },
    chatMessages: { id: 'chatMessages.id' },
    agentRuns: { id: 'agentRuns.id' },
    agentRunEvents: { runId: 'agentRunEvents.runId', seq: 'agentRunEvents.seq' },
    conversations: { id: 'conversations.id' },
    eq: vi.fn(() => 'eq'),
    asc: vi.fn(() => 'asc'),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values }),
  };
});

import { buildProjection, materializeFromLog } from '../materializeFromLog';
import { initialRunState, applyEvent } from '../applyEvent';
import type { RunEvent } from '../types';

const runId = 'run_abc';

function reduce(events: Array<Omit<RunEvent, 'runId'>>): ReturnType<typeof initialRunState> {
  return events.reduce(
    (state, e) => applyEvent(state, { runId, ...e } as RunEvent),
    initialRunState(runId),
  );
}

beforeEach(() => {
  testState.agentRun = null;
  testState.conversation = null;
  testState.events = [];
  testState.insertedValues = null;
  testState.conflictUpdateSet = null;
});

describe('buildProjection', () => {
  it('given a state with only text parts, should produce structured content with text and no tool columns', () => {
    const state = reduce([
      { seq: 1, type: 'text-segment', payload: { text: 'hello ' } },
      { seq: 2, type: 'text-segment', payload: { text: 'world' } },
      { seq: 3, type: 'finish', payload: {} },
    ]);
    const p = buildProjection(state);
    const content = JSON.parse(p.structuredContent) as StructuredContent;
    expect(content.textParts).toEqual(['hello world']);
    expect(content.partsOrder).toEqual([{ index: 0, type: 'text' }]);
    expect(content.originalContent).toBe('hello world');
    expect(p.toolCalls).toBeNull();
    expect(p.toolResults).toBeNull();
  });

  it('given a state with a completed tool call, should include both toolCalls and toolResults with output-available state', () => {
    const state = reduce([
      { seq: 1, type: 'tool-input', payload: { callId: 'c1', toolName: 'search', input: { q: 'x' } } },
      { seq: 2, type: 'tool-result', payload: { callId: 'c1', output: { hits: 3 } } },
      { seq: 3, type: 'finish', payload: {} },
    ]);
    const p = buildProjection(state);
    expect(p.toolCalls).toEqual([
      { toolCallId: 'c1', toolName: 'search', input: { q: 'x' }, state: 'output-available' },
    ] satisfies ToolCallOut[]);
    expect(p.toolResults).toEqual([
      { toolCallId: 'c1', toolName: 'search', output: { hits: 3 }, state: 'output-available' },
    ] satisfies ToolResultOut[]);
  });

  it('given a state with an errored tool call, should mark both entries as output-error', () => {
    const state = reduce([
      { seq: 1, type: 'tool-input', payload: { callId: 'c1', toolName: 'search', input: {} } },
      { seq: 2, type: 'tool-result', payload: { callId: 'c1', output: 'boom', isError: true } },
      { seq: 3, type: 'finish', payload: {} },
    ]);
    const p = buildProjection(state);
    expect(p.toolCalls?.[0].state).toBe('output-error');
    expect(p.toolResults?.[0].state).toBe('output-error');
  });

  it('given a state with a pending tool call (no result before terminal), should omit it from toolResults', () => {
    const state = reduce([
      { seq: 1, type: 'tool-input', payload: { callId: 'c1', toolName: 'search', input: {} } },
      { seq: 2, type: 'error', payload: { message: 'aborted' } },
    ]);
    const p = buildProjection(state);
    expect(p.toolCalls?.[0].state).toBe('input-available');
    expect(p.toolResults).toBeNull();
  });

  it('given mixed text and tool parts, should preserve partsOrder indexes and types', () => {
    const state = reduce([
      { seq: 1, type: 'text-segment', payload: { text: 'thinking' } },
      { seq: 2, type: 'tool-input', payload: { callId: 'c1', toolName: 'search', input: {} } },
      { seq: 3, type: 'tool-result', payload: { callId: 'c1', output: 'ok' } },
      { seq: 4, type: 'text-segment', payload: { text: 'done' } },
      { seq: 5, type: 'finish', payload: {} },
    ]);
    const p = buildProjection(state);
    const content = JSON.parse(p.structuredContent) as StructuredContent;
    expect(content.partsOrder).toEqual([
      { index: 0, type: 'text' },
      { index: 1, type: 'tool-search', toolCallId: 'c1' },
      { index: 2, type: 'text' },
    ]);
    expect(content.textParts).toEqual(['thinking', 'done']);
    expect(content.originalContent).toBe('thinkingdone');
  });
});

describe('materializeFromLog', () => {
  function seedTerminalRun(overrides: { status?: string } = {}) {
    testState.agentRun = {
      id: runId,
      conversationId: 'conv_1',
      status: overrides.status ?? 'completed',
      completedAt: new Date('2026-04-19T10:00:00Z'),
      startedAt: new Date('2026-04-19T09:59:00Z'),
    };
    testState.conversation = { id: 'conv_1', type: 'page', contextId: 'page_1' };
  }

  it('given a terminal page-scoped run, should insert a chatMessages row with the projected content', async () => {
    seedTerminalRun();
    testState.events = [
      { seq: 1, type: 'text-segment', payload: { text: 'hi' } },
      { seq: 2, type: 'finish', payload: {} },
    ];
    const result = await materializeFromLog({ runId });
    expect(result.messageId).toBe(runId);
    expect(testState.insertedValues).toMatchObject({
      id: runId,
      pageId: 'page_1',
      conversationId: 'conv_1',
      userId: null,
      role: 'assistant',
      isActive: true,
    });
  });

  it('given an already-materialized run, should upsert via onConflictDoUpdate so the call is idempotent', async () => {
    seedTerminalRun();
    testState.events = [
      { seq: 1, type: 'text-segment', payload: { text: 'hi' } },
      { seq: 2, type: 'finish', payload: {} },
    ];
    await materializeFromLog({ runId });
    expect(testState.conflictUpdateSet).toBeDefined();
    expect(testState.conflictUpdateSet).toHaveProperty('content');
  });

  it('given a run that does not exist, should throw with the runId in the message', async () => {
    testState.agentRun = null;
    await expect(materializeFromLog({ runId: 'run_missing' })).rejects.toThrow(/run_missing/);
  });

  it('given a run that is still streaming, should throw because only terminal runs are materializable', async () => {
    seedTerminalRun({ status: 'streaming' });
    await expect(materializeFromLog({ runId })).rejects.toThrow(/not terminal/i);
  });

  it('given a run whose conversation row is missing, should throw so dangling runs surface', async () => {
    seedTerminalRun();
    testState.conversation = null;
    await expect(materializeFromLog({ runId })).rejects.toThrow(/conversation.*not found/i);
  });

  it('given a conversation whose type is not page, should throw so global/drive runs do not write to chatMessages', async () => {
    seedTerminalRun();
    testState.conversation = { id: 'conv_1', type: 'global', contextId: null };
    testState.events = [{ seq: 1, type: 'finish', payload: {} }];
    await expect(materializeFromLog({ runId })).rejects.toThrow(/page conversation/i);
  });

  it('given a terminal run with tool calls, should pass stringified toolCalls and toolResults to insert', async () => {
    seedTerminalRun();
    testState.events = [
      { seq: 1, type: 'tool-input', payload: { callId: 'c1', toolName: 'search', input: { q: 'x' } } },
      { seq: 2, type: 'tool-result', payload: { callId: 'c1', output: { hits: 3 } } },
      { seq: 3, type: 'finish', payload: {} },
    ];
    await materializeFromLog({ runId });
    const inserted = testState.insertedValues!;
    expect(typeof inserted.toolCalls).toBe('string');
    expect(typeof inserted.toolResults).toBe('string');
    const parsedCalls = JSON.parse(inserted.toolCalls as string) as ToolCallOut[];
    expect(parsedCalls[0].toolCallId).toBe('c1');
  });
});
