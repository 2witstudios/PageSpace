import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { useGroupedParts } from '../useGroupedParts';
import { isTextGroupPart, isFileGroupPart, isProcessedToolPart } from '../message-types';

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
    expect(isProcessedToolPart(result.current[1])).toBe(true);
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
    expect(isProcessedToolPart(result.current[1])).toBe(true);
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
    if (isProcessedToolPart(group)) {
      expect(group.state).toBe('input-available');
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
});
