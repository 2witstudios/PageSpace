import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { useGroupedParts } from '../useGroupedParts';
import { isTextGroupPart, isFileGroupPart, isProcessedToolPart, isToolRunGroupPart } from '../message-types';

type Parts = UIMessage['parts'];

function asMessageParts(parts: unknown[]): Parts {
  return parts as unknown as Parts;
}

describe('useGroupedParts', () => {
  it('given undefined parts, should return empty array', () => {
    const { result } = renderHook(() => useGroupedParts(undefined));
    expect(result.current).toEqual([]);
  });

  it('given empty parts array, should return empty array', () => {
    const { result } = renderHook(() => useGroupedParts([]));
    expect(result.current).toEqual([]);
  });

  it('given consecutive text parts, should group them together', () => {
    const parts = asMessageParts([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(1);
    const group = result.current[0];
    expect(isTextGroupPart(group)).toBe(true);
    if (isTextGroupPart(group)) {
      expect(group.parts).toHaveLength(2);
      expect(group.parts[0].text).toBe('Hello');
      expect(group.parts[1].text).toBe(' world');
    }
  });

  it('given consecutive file parts, should group them together', () => {
    const parts = asMessageParts([
      { type: 'file', url: 'data:image/png;base64,abc', mediaType: 'image/png', filename: 'a.png' },
      { type: 'file', url: 'data:image/jpeg;base64,xyz', mediaType: 'image/jpeg', filename: 'b.jpg' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(1);
    const group = result.current[0];
    expect(isFileGroupPart(group)).toBe(true);
    if (isFileGroupPart(group)) {
      expect(group.parts).toHaveLength(2);
      expect(group.parts[0].filename).toBe('a.png');
      expect(group.parts[1].filename).toBe('b.jpg');
    }
  });

  it('given text then file then text, should produce 3 groups', () => {
    const parts = asMessageParts([
      { type: 'text', text: 'Check this:' },
      { type: 'file', url: 'data:image/png;base64,abc', mediaType: 'image/png' },
      { type: 'text', text: 'What do you think?' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(3);
    expect(isTextGroupPart(result.current[0])).toBe(true);
    expect(isFileGroupPart(result.current[1])).toBe(true);
    expect(isTextGroupPart(result.current[2])).toBe(true);
  });

  it('given a tool part between texts, should flush text group and add tool individually', () => {
    const parts = asMessageParts([
      { type: 'text', text: 'Before' },
      {
        type: 'tool-invocation',
        toolCallId: 'tc-1',
        toolName: 'search',
        state: 'output-available',
        input: { query: 'test' },
        output: { results: [] },
      },
      { type: 'text', text: 'After' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(3);
    expect(isTextGroupPart(result.current[0])).toBe(true);
    expect(isToolRunGroupPart(result.current[1])).toBe(true);
    if (isToolRunGroupPart(result.current[1])) {
      expect(result.current[1].parts).toHaveLength(1);
    }
    expect(isTextGroupPart(result.current[2])).toBe(true);
  });

  it('given a tool part between file parts, should flush file group before tool', () => {
    const parts = asMessageParts([
      { type: 'file', url: 'data:image/png;base64,abc', mediaType: 'image/png' },
      {
        type: 'tool-invocation',
        toolCallId: 'tc-1',
        toolName: 'analyze_image',
        state: 'output-available',
        input: {},
      },
      { type: 'file', url: 'data:image/jpeg;base64,xyz', mediaType: 'image/jpeg' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(3);
    expect(isFileGroupPart(result.current[0])).toBe(true);
    expect(isToolRunGroupPart(result.current[1])).toBe(true);
    if (isToolRunGroupPart(result.current[1])) {
      expect(result.current[1].parts).toHaveLength(1);
    }
    expect(isFileGroupPart(result.current[2])).toBe(true);
  });

  it('given step-start and reasoning parts, should skip them', () => {
    const parts = asMessageParts([
      { type: 'step-start' },
      { type: 'reasoning', text: 'thinking...' },
      { type: 'text', text: 'Visible text' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(1);
    expect(isTextGroupPart(result.current[0])).toBe(true);
  });

  it('given file parts with missing url, should default to empty string', () => {
    const parts = asMessageParts([
      { type: 'file', mediaType: 'image/png' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(1);
    const group = result.current[0];
    if (isFileGroupPart(group)) {
      expect(group.parts[0].url).toBe('');
    }
  });

  it('given a tool with invalid state, should default to input-available', () => {
    const parts = asMessageParts([
      {
        type: 'tool-invocation',
        toolCallId: 'tc-1',
        toolName: 'search',
        state: 'BOGUS_STATE',
        input: {},
      },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(1);
    const group = result.current[0];
    expect(isToolRunGroupPart(group)).toBe(true);
    if (isToolRunGroupPart(group)) {
      expect(group.parts[0].state).toBe('input-available');
    }
  });

  it('given a finish tool part, should skip it entirely', () => {
    const parts = asMessageParts([
      { type: 'text', text: 'Done' },
      {
        type: 'tool-invocation',
        toolCallId: 'tc-finish',
        toolName: 'finish',
        state: 'output-available',
        input: { reason: 'Task completed' },
        output: { done: true },
      },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(1);
    expect(isTextGroupPart(result.current[0])).toBe(true);
  });

  it('given a finish tool part between text parts, should not create a group for it', () => {
    const parts = asMessageParts([
      { type: 'text', text: 'Before' },
      {
        type: 'tool-invocation',
        toolCallId: 'tc-finish',
        toolName: 'finish',
        state: 'output-available',
        input: {},
      },
      { type: 'text', text: 'After' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    // finish is skipped, so both text parts merge into one group
    expect(result.current).toHaveLength(1);
    expect(isTextGroupPart(result.current[0])).toBe(true);
    if (isTextGroupPart(result.current[0])) {
      expect(result.current[0].parts).toHaveLength(2);
    }
  });

  it('given trailing file parts at end, should flush them', () => {
    const parts = asMessageParts([
      { type: 'text', text: 'Images:' },
      { type: 'file', url: 'data:image/png;base64,a', mediaType: 'image/png' },
      { type: 'file', url: 'data:image/png;base64,b', mediaType: 'image/png' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(2);
    expect(isTextGroupPart(result.current[0])).toBe(true);
    expect(isFileGroupPart(result.current[1])).toBe(true);
    const group = result.current[1];
    if (isFileGroupPart(group)) {
      expect(group.parts).toHaveLength(2);
    }
  });

  it('given 2+ consecutive non-diff tool calls, should collapse into one tool-run-group', () => {
    const parts = asMessageParts([
      { type: 'tool-bash', toolCallId: 'tc-1', toolName: 'bash', state: 'output-available', input: { command: 'ls' }, output: 'ok' },
      { type: 'tool-bash', toolCallId: 'tc-2', toolName: 'bash', state: 'output-available', input: { command: 'pwd' }, output: '/' },
      { type: 'tool-gh', toolCallId: 'tc-3', toolName: 'gh', state: 'output-available', input: {}, output: 'ok' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(1);
    const group = result.current[0];
    expect(isToolRunGroupPart(group)).toBe(true);
    if (isToolRunGroupPart(group)) {
      expect(group.parts).toHaveLength(3);
      expect(group.parts.map(p => p.toolName)).toEqual(['bash', 'bash', 'gh']);
    }
  });

  it('given a single non-diff tool call, should render it as a length-1 run carrying a stable runKey', () => {
    const parts = asMessageParts([
      { type: 'tool-bash', toolCallId: 'tc-1', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(1);
    const group = result.current[0];
    expect(isToolRunGroupPart(group)).toBe(true);
    if (isToolRunGroupPart(group)) {
      expect(group.parts).toHaveLength(1);
      expect(group.runKey).toBe('run:tc-1');
    }
  });

  it('given a 2nd consecutive call joins an existing run, should keep the same runKey as before it joined', () => {
    const solo = asMessageParts([
      { type: 'tool-bash', toolCallId: 'tc-1', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
    ]);
    const { result, rerender } = renderHook(({ parts }) => useGroupedParts(parts), {
      initialProps: { parts: solo },
    });

    const soloGroup = result.current[0];
    expect(isToolRunGroupPart(soloGroup)).toBe(true);
    const soloRunKey = isToolRunGroupPart(soloGroup) ? soloGroup.runKey : undefined;

    const grown = asMessageParts([
      { type: 'tool-bash', toolCallId: 'tc-1', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      { type: 'tool-bash', toolCallId: 'tc-2', toolName: 'bash', state: 'input-available', input: {} },
    ]);
    rerender({ parts: grown });

    const grownGroup = result.current[0];
    expect(result.current).toHaveLength(1);
    expect(isToolRunGroupPart(grownGroup)).toBe(true);
    if (isToolRunGroupPart(grownGroup)) {
      expect(grownGroup.parts).toHaveLength(2);
      expect(grownGroup.runKey).toBe(soloRunKey);
    }
  });

  it('given a diff tool call in the middle of a run, should break the run in two with different runKeys', () => {
    const parts = asMessageParts([
      { type: 'tool-bash', toolCallId: 'tc-1', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      { type: 'tool-bash', toolCallId: 'tc-2', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      { type: 'tool-edit', toolCallId: 'tc-3', toolName: 'edit', state: 'output-available', input: { file_path: 'foo.ts' }, output: 'ok' },
      { type: 'tool-bash', toolCallId: 'tc-4', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      { type: 'tool-bash', toolCallId: 'tc-5', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(3);
    expect(isToolRunGroupPart(result.current[0])).toBe(true);
    expect(isProcessedToolPart(result.current[1])).toBe(true);
    if (isProcessedToolPart(result.current[1])) {
      expect(result.current[1].toolName).toBe('edit');
    }
    expect(isToolRunGroupPart(result.current[2])).toBe(true);
    if (isToolRunGroupPart(result.current[0]) && isToolRunGroupPart(result.current[2])) {
      expect(result.current[0].runKey).not.toBe(result.current[2].runKey);
    }
  });

  it('given an execute_tool-wrapped diff tool, should still break a run by the inner tool name', () => {
    const parts = asMessageParts([
      { type: 'tool-bash', toolCallId: 'tc-1', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      { type: 'tool-bash', toolCallId: 'tc-2', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      {
        type: 'tool-execute_tool',
        toolCallId: 'tc-3',
        toolName: 'execute_tool',
        state: 'output-available',
        input: { tool_name: 'replace_lines', parameters: { pageId: 'p1' } },
        output: 'ok',
      },
      { type: 'tool-bash', toolCallId: 'tc-4', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      { type: 'tool-bash', toolCallId: 'tc-5', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(3);
    expect(isToolRunGroupPart(result.current[0])).toBe(true);
    expect(isProcessedToolPart(result.current[1])).toBe(true);
    if (isProcessedToolPart(result.current[1])) {
      expect(result.current[1].toolName).toBe('execute_tool');
    }
    expect(isToolRunGroupPart(result.current[2])).toBe(true);
  });

  it('given a hidden tool_search call between visible tool calls, should skip it entirely and merge the run across it', () => {
    const parts = asMessageParts([
      { type: 'tool-bash', toolCallId: 'tc-1', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      { type: 'tool-tool_search', toolCallId: 'tc-2', toolName: 'tool_search', state: 'output-available', input: { query: 'edit' }, output: '[]' },
      { type: 'tool-bash', toolCallId: 'tc-3', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    // tool_search is invisible: the two bash calls merge into one run of 2,
    // and the search call must not appear anywhere in the output.
    expect(result.current).toHaveLength(1);
    const group = result.current[0];
    expect(isToolRunGroupPart(group)).toBe(true);
    if (isToolRunGroupPart(group)) {
      expect(group.parts).toHaveLength(2);
      expect(group.parts.every(p => p.toolName !== 'tool_search')).toBe(true);
    }
  });

  it('given a run consisting only of tool_search calls, should produce no group at all', () => {
    const parts = asMessageParts([
      { type: 'tool-tool_search', toolCallId: 'tc-1', toolName: 'tool_search', state: 'output-available', input: { query: 'a' }, output: '[]' },
      { type: 'tool-tool_search', toolCallId: 'tc-2', toolName: 'tool_search', state: 'output-available', input: { query: 'b' }, output: '[]' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(0);
  });

  it('given an execute_tool-wrapped tool_search, should also skip it', () => {
    const parts = asMessageParts([
      { type: 'tool-bash', toolCallId: 'tc-1', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      {
        type: 'tool-execute_tool',
        toolCallId: 'tc-2',
        toolName: 'execute_tool',
        state: 'output-available',
        input: { tool_name: 'tool_search', parameters: { query: 'edit' } },
        output: '[]',
      },
      { type: 'tool-bash', toolCallId: 'tc-3', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    expect(result.current).toHaveLength(1);
    const group = result.current[0];
    expect(isToolRunGroupPart(group)).toBe(true);
    if (isToolRunGroupPart(group)) {
      expect(group.parts).toHaveLength(2);
      expect(group.parts.every(p => p.toolName !== 'execute_tool')).toBe(true);
    }
  });

  it('given consecutive task tool calls, should NOT collapse them (SPECIAL_HANDLED_TOOLS stand alone)', () => {
    const parts = asMessageParts([
      { type: 'tool-update_task', toolCallId: 'tc-1', toolName: 'update_task', state: 'output-available', input: { taskId: 't1' }, output: 'ok' },
      { type: 'tool-update_task', toolCallId: 'tc-2', toolName: 'update_task', state: 'output-available', input: { taskId: 't2' }, output: 'ok' },
      { type: 'tool-create_task', toolCallId: 'tc-3', toolName: 'create_task', state: 'output-available', input: {}, output: 'ok' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    // Each task tool call renders standalone — TaskRenderer's own aggregated
    // list view is how these should be scanned, not a generic run summary.
    expect(result.current).toHaveLength(3);
    result.current.forEach((group) => {
      expect(isProcessedToolPart(group)).toBe(true);
      expect(isToolRunGroupPart(group)).toBe(false);
    });
  });

  it('given consecutive ask_agent calls sandwiched by bash calls, should keep ask_agent standalone and group the bash calls around it', () => {
    const parts = asMessageParts([
      { type: 'tool-bash', toolCallId: 'tc-1', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      { type: 'tool-bash', toolCallId: 'tc-2', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      { type: 'tool-ask_agent', toolCallId: 'tc-3', toolName: 'ask_agent', state: 'output-available', input: { question: 'q' }, output: 'ok' },
      { type: 'tool-ask_agent', toolCallId: 'tc-4', toolName: 'ask_agent', state: 'output-available', input: { question: 'q2' }, output: 'ok' },
      { type: 'tool-bash', toolCallId: 'tc-5', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      { type: 'tool-bash', toolCallId: 'tc-6', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    // bash run, then two standalone ask_agent calls (each its own entry, not
    // merged with each other), then another bash run.
    expect(result.current).toHaveLength(4);
    expect(isToolRunGroupPart(result.current[0])).toBe(true);
    expect(isProcessedToolPart(result.current[1])).toBe(true);
    expect(isProcessedToolPart(result.current[2])).toBe(true);
    if (isProcessedToolPart(result.current[1]) && isProcessedToolPart(result.current[2])) {
      expect(result.current[1].toolName).toBe('ask_agent');
      expect(result.current[2].toolName).toBe('ask_agent');
    }
    expect(isToolRunGroupPart(result.current[3])).toBe(true);
  });
});

/**
 * A group's position in this hook's output is not a stable identity: a later
 * group can vanish (a tool resolving to a hidden one) or split (a tool
 * resolving to a standalone one), shifting every following index. Keying React
 * subtrees on that position remounts them mid-stream — re-parsing markdown and
 * reflowing row heights while the user watches. groupId is derived from the raw
 * part index of the group's first member instead, which never moves because
 * part accumulation is append-only.
 */
describe('useGroupedParts stable group ids', () => {
  it('given a text group, should derive its id from the raw index of its first part', () => {
    const parts = asMessageParts([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    const group = result.current[0];
    expect(isTextGroupPart(group)).toBe(true);
    if (isTextGroupPart(group)) expect(group.groupId).toBe('text:0');
  });

  it('given text, a file, and more text, should give each group an id fixed to its own first part', () => {
    const parts = asMessageParts([
      { type: 'text', text: 'Check this:' },
      { type: 'file', url: 'data:image/png;base64,abc', mediaType: 'image/png' },
      { type: 'text', text: 'What do you think?' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    const [first, second, third] = result.current;
    if (isTextGroupPart(first)) expect(first.groupId).toBe('text:0');
    if (isFileGroupPart(second)) expect(second.groupId).toBe('file:1');
    if (isTextGroupPart(third)) expect(third.groupId).toBe('text:2');
  });

  it('given a skipped step-start before the text, should still index the text group by its own raw position', () => {
    const parts = asMessageParts([
      { type: 'step-start' },
      { type: 'text', text: 'Hello' },
    ]);
    const { result } = renderHook(() => useGroupedParts(parts));

    const group = result.current[0];
    if (isTextGroupPart(group)) expect(group.groupId).toBe('text:1');
  });

  it('given a later tool call appended mid-stream, should leave the earlier text group id untouched', () => {
    const before = asMessageParts([
      { type: 'text', text: 'Working on it' },
      { type: 'tool-bash', toolCallId: 'tc-1', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
    ]);
    const { result, rerender } = renderHook(({ parts }) => useGroupedParts(parts), {
      initialProps: { parts: before },
    });

    const firstIdBefore = isTextGroupPart(result.current[0]) ? result.current[0].groupId : null;

    rerender({
      parts: asMessageParts([
        { type: 'text', text: 'Working on it' },
        { type: 'tool-bash', toolCallId: 'tc-1', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
        { type: 'tool-bash', toolCallId: 'tc-2', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
      ]),
    });

    const firstIdAfter = isTextGroupPart(result.current[0]) ? result.current[0].groupId : null;
    expect(firstIdAfter).toBe(firstIdBefore);
  });

  it('given a hidden tool between two text runs, should keep the leading text group id stable across the merge', () => {
    // While `input` is still streaming the tool reads as an ordinary call and
    // splits the text; once it resolves to tool_search it is dropped and the
    // two text runs merge. The leading group must not be remounted by that.
    const streaming = asMessageParts([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool-execute_tool', toolCallId: 'tc-1', toolName: 'execute_tool', state: 'input-streaming', input: {} },
      { type: 'text', text: 'Found it.' },
    ]);
    const { result, rerender } = renderHook(({ parts }) => useGroupedParts(parts), {
      initialProps: { parts: streaming },
    });

    const leadingIdBefore = isTextGroupPart(result.current[0]) ? result.current[0].groupId : null;
    expect(leadingIdBefore).toBe('text:0');

    rerender({
      parts: asMessageParts([
        { type: 'text', text: 'Let me look.' },
        {
          type: 'tool-execute_tool',
          toolCallId: 'tc-1',
          toolName: 'execute_tool',
          state: 'output-available',
          input: { tool_name: 'tool_search' },
          output: 'ok',
        },
        { type: 'text', text: 'Found it.' },
      ]),
    });

    const leadingGroup = result.current[0];
    expect(isTextGroupPart(leadingGroup)).toBe(true);
    if (isTextGroupPart(leadingGroup)) {
      expect(leadingGroup.groupId).toBe(leadingIdBefore);
    }
  });
});
