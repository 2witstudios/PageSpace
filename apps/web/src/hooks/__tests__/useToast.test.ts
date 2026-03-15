/**
 * useToast Hook Tests
 * Tests for the toast notification system: add, dismiss, auto-remove
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useToast } from '../useToast';

describe('useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should start with an empty toasts array', () => {
    const { result } = renderHook(() => useToast());

    expect(result.current.toasts).toEqual([]);
  });

  it('should add a toast when toast() is called', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Test toast' });
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].title).toBe('Test toast');
  });

  it('should assign a unique ID to each toast', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Toast 1' });
      result.current.toast({ title: 'Toast 2' });
    });

    const ids = result.current.toasts.map((t) => t.id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('should return the toast ID from toast()', () => {
    const { result } = renderHook(() => useToast());

    let id: string | undefined;
    act(() => {
      id = result.current.toast({ title: 'Test' });
    });

    expect(id).toBeDefined();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^toast-/);
  });

  it('should include description when provided', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Title', description: 'Details here' });
    });

    expect(result.current.toasts[0].description).toBe('Details here');
  });

  it('should default variant to "default" when not specified', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Default toast' });
    });

    expect(result.current.toasts[0].variant).toBe('default');
  });

  it('should set variant to "destructive" when specified', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Error', variant: 'destructive' });
    });

    expect(result.current.toasts[0].variant).toBe('destructive');
  });

  it('should log to console.log for default variant', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Info', description: 'Some info' });
    });

    expect(console.log).toHaveBeenCalledWith('[Toast] Info:', 'Some info');
  });

  it('should log to console.error for destructive variant', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Oops', description: 'Something failed', variant: 'destructive' });
    });

    expect(console.error).toHaveBeenCalledWith('[Toast Error] Oops:', 'Something failed');
  });

  it('should auto-remove a toast after 5 seconds', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Temporary toast' });
    });

    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.toasts).toHaveLength(0);
  });

  it('should not auto-remove a toast before 5 seconds', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Still here' });
    });

    act(() => {
      vi.advanceTimersByTime(4999);
    });

    expect(result.current.toasts).toHaveLength(1);
  });

  it('should dismiss a specific toast by ID', () => {
    const { result } = renderHook(() => useToast());

    let id: string | undefined;
    act(() => {
      id = result.current.toast({ title: 'To dismiss' });
      result.current.toast({ title: 'To keep' });
    });

    expect(result.current.toasts).toHaveLength(2);

    act(() => {
      result.current.dismiss(id!);
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].title).toBe('To keep');
  });

  it('should handle dismissing a non-existent toast ID gracefully', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'Existing' });
    });

    act(() => {
      result.current.dismiss('non-existent-id');
    });

    expect(result.current.toasts).toHaveLength(1);
  });

  it('should support adding multiple toasts', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'First' });
      result.current.toast({ title: 'Second' });
      result.current.toast({ title: 'Third' });
    });

    expect(result.current.toasts).toHaveLength(3);
  });

  it('should auto-remove toasts independently based on their creation time', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({ title: 'First' });
    });

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    act(() => {
      result.current.toast({ title: 'Second' });
    });

    // At 5000ms from start, first toast should be gone
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].title).toBe('Second');

    // At 7000ms from start, second toast should also be gone
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.toasts).toHaveLength(0);
  });
});
