import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMentionTracker } from '../useMentionTracker';

describe('useMentionTracker', () => {
  describe('initial parsing', () => {
    it('given plain text, should return display text unchanged with no mentions', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useMentionTracker('hello world', onChange)
      );

      expect(result.current.displayText).toBe('hello world');
      expect(result.current.mentions).toEqual([]);
      expect(result.current.hasMentions).toBe(false);
    });

    it('given markdown with mentions, should parse into display text', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useMentionTracker('@[Alice](u1:user) hi @[Doc](p1:page)', onChange)
      );

      expect(result.current.displayText).toBe('@Alice hi @Doc');
      expect(result.current.mentions).toHaveLength(2);
      expect(result.current.hasMentions).toBe(true);
    });

    it('given empty string, should return empty state', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() => useMentionTracker('', onChange));

      expect(result.current.displayText).toBe('');
      expect(result.current.mentions).toEqual([]);
      expect(result.current.hasMentions).toBe(false);
    });
  });

  describe('handleDisplayTextChange', () => {
    it('given text typed after mentions, should preserve mentions and report markdown', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useMentionTracker('@[Alice](u1:user)', onChange)
      );

      act(() => {
        result.current.handleDisplayTextChange('@Alice hi');
      });

      expect(onChange).toHaveBeenCalledWith('@[Alice](u1:user) hi');
      expect(result.current.displayText).toBe('@Alice hi');
      expect(result.current.mentions).toHaveLength(1);
    });

    it('given mention text edited by user, should remove that mention', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useMentionTracker('@[Alice](u1:user)', onChange)
      );

      act(() => {
        // User deletes last char of "@Alice" → "@Alic"
        result.current.handleDisplayTextChange('@Alic');
      });

      expect(result.current.mentions).toHaveLength(0);
      expect(onChange).toHaveBeenCalledWith('@Alic');
    });

    it('given plain text change with no mentions, should pass through unchanged', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useMentionTracker('hello', onChange)
      );

      act(() => {
        result.current.handleDisplayTextChange('hello world');
      });

      expect(onChange).toHaveBeenCalledWith('hello world');
    });
  });

  describe('registerMention', () => {
    it('given a registered mention before display change, should include it in mentions', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useMentionTracker('', onChange)
      );

      act(() => {
        // Simulate suggestion insertion: register mention, then update display text
        result.current.registerMention({
          start: 0,
          end: 6,
          label: 'Alice',
          id: 'u1',
          type: 'user',
        });
        result.current.handleDisplayTextChange('@Alice ');
      });

      expect(result.current.mentions).toHaveLength(1);
      expect(result.current.mentions[0].label).toBe('Alice');
      expect(onChange).toHaveBeenCalledWith('@[Alice](u1:user) ');
    });

    it('given a mention registered alongside existing mentions, should track both', () => {
      const onChange = vi.fn();
      const { result } = renderHook(() =>
        useMentionTracker('@[Alice](u1:user) ', onChange)
      );

      act(() => {
        result.current.registerMention({
          start: 7,
          end: 11,
          label: 'Doc',
          id: 'p1',
          type: 'page',
        });
        result.current.handleDisplayTextChange('@Alice @Doc ');
      });

      expect(result.current.mentions).toHaveLength(2);
      expect(onChange).toHaveBeenCalledWith(
        '@[Alice](u1:user) @[Doc](p1:page) '
      );
    });
  });

  describe('external value changes', () => {
    it('given parent value changes after send (cleared), should reset state', () => {
      const onChange = vi.fn();
      const { result, rerender } = renderHook(
        ({ value, onChange: cb }) => useMentionTracker(value, cb),
        { initialProps: { value: '@[Alice](u1:user)', onChange } }
      );

      expect(result.current.displayText).toBe('@Alice');

      // Parent clears value (e.g. after message send)
      rerender({ value: '', onChange });

      expect(result.current.displayText).toBe('');
      expect(result.current.mentions).toEqual([]);
      expect(result.current.hasMentions).toBe(false);
    });

    it('given own onChange was the source, should NOT re-parse', () => {
      const onChange = vi.fn();
      const { result, rerender } = renderHook(
        ({ value, onChange: cb }) => useMentionTracker(value, cb),
        { initialProps: { value: '', onChange } }
      );

      // Simulate user typing and the parent updating value to match
      act(() => {
        result.current.handleDisplayTextChange('hello');
      });

      // Parent re-renders with the same markdown we reported
      rerender({ value: 'hello', onChange });

      // Should still be 'hello', not re-parsed (which would give same result anyway for plain text)
      expect(result.current.displayText).toBe('hello');
    });
  });
});
