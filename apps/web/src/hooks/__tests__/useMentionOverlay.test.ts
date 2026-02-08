import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMentionOverlay } from '../useMentionOverlay';

describe('useMentionOverlay', () => {
  const createTextareaRef = (scrollTop = 0) => ({
    current: { scrollTop } as HTMLTextAreaElement,
  });

  describe('hasMentions', () => {
    it('given false, should return false', () => {
      const ref = createTextareaRef();
      const { result } = renderHook(() => useMentionOverlay(ref, false));

      expect(result.current.hasMentions).toBe(false);
    });

    it('given true, should return true', () => {
      const ref = createTextareaRef();
      const { result } = renderHook(() => useMentionOverlay(ref, true));

      expect(result.current.hasMentions).toBe(true);
    });
  });

  describe('overlayRef', () => {
    it('given initial render, should return a ref with current null', () => {
      const ref = createTextareaRef();
      const { result } = renderHook(() => useMentionOverlay(ref, false));

      expect(result.current.overlayRef).toHaveProperty('current', null);
    });
  });

  describe('handleScroll', () => {
    it('given textarea with scrollTop, should sync to overlay scrollTop', () => {
      const textareaRef = createTextareaRef(100);
      const { result } = renderHook(() =>
        useMentionOverlay(textareaRef, false)
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
        useMentionOverlay(textareaRef, false)
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
