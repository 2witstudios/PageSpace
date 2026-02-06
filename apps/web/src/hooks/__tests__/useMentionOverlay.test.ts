import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMentionOverlay } from '../useMentionOverlay';

describe('useMentionOverlay', () => {
  const createTextareaRef = (scrollTop = 0) => ({
    current: { scrollTop } as HTMLTextAreaElement,
  });

  describe('hasMentions', () => {
    it('given plain text, should return false', () => {
      const ref = createTextareaRef();
      const { result } = renderHook(() => useMentionOverlay(ref, 'hello world'));

      expect(result.current.hasMentions).toBe(false);
    });

    it('given text with page mention, should return true', () => {
      const ref = createTextareaRef();
      const { result } = renderHook(() =>
        useMentionOverlay(ref, 'Hi @[Doc](id:page)')
      );

      expect(result.current.hasMentions).toBe(true);
    });

    it('given text with user mention, should return true', () => {
      const ref = createTextareaRef();
      const { result } = renderHook(() =>
        useMentionOverlay(ref, 'Hi @[Alice](user1:user)')
      );

      expect(result.current.hasMentions).toBe(true);
    });

    it('given incomplete mention syntax, should return false', () => {
      const ref = createTextareaRef();
      const { result } = renderHook(() =>
        useMentionOverlay(ref, '@[incomplete](missing)')
      );

      expect(result.current.hasMentions).toBe(false);
    });
  });

  describe('overlayRef', () => {
    it('given initial render, should return a ref with current null', () => {
      const ref = createTextareaRef();
      const { result } = renderHook(() => useMentionOverlay(ref, 'test'));

      expect(result.current.overlayRef).toHaveProperty('current', null);
    });
  });

  describe('handleScroll', () => {
    it('given textarea with scrollTop, should sync to overlay scrollTop', () => {
      const textareaRef = createTextareaRef(100);
      const { result } = renderHook(() =>
        useMentionOverlay(textareaRef, 'test')
      );

      // Simulate an overlay element being attached to the ref
      const overlayEl = { scrollTop: 0 } as HTMLDivElement;
      (result.current.overlayRef as React.MutableRefObject<HTMLDivElement>).current = overlayEl;

      act(() => {
        result.current.handleScroll();
      });

      expect(overlayEl.scrollTop).toBe(100);
    });

    it('given no overlay element, should not throw', () => {
      const textareaRef = createTextareaRef(50);
      const { result } = renderHook(() =>
        useMentionOverlay(textareaRef, 'test')
      );

      // overlayRef.current is null by default - should not throw
      expect(() => {
        act(() => {
          result.current.handleScroll();
        });
      }).not.toThrow();
    });
  });
});
