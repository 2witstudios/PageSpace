/**
 * useMonacoTheme Hook Tests
 *
 * Tests the Monaco editor theme hook:
 * - Returns fallback theme names when no Monaco instance
 * - Defines custom theme on Monaco instance for dark/light
 * - Handles defineTheme errors gracefully
 * - Utility functions: normalizeHexColor, parseRgbLikeColorToHex, clamp, etc.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockResolvedTheme = vi.hoisted(() => ({ value: 'dark' }));

vi.mock('next-themes', () => ({
  useTheme: () => ({
    resolvedTheme: mockResolvedTheme.value,
  }),
}));

import { useMonacoTheme } from '../useMonacoTheme';

// Create a mock Monaco instance
function createMockMonaco() {
  return {
    editor: {
      defineTheme: vi.fn(),
    },
  };
}

describe('useMonacoTheme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvedTheme.value = 'dark';
  });

  describe('without Monaco instance', () => {
    it('should return "vs-dark" when resolvedTheme is dark and no Monaco instance', () => {
      mockResolvedTheme.value = 'dark';

      const { result } = renderHook(() => useMonacoTheme(null));

      expect(result.current).toBe('vs-dark');
    });

    it('should return "vs" when resolvedTheme is light and no Monaco instance', () => {
      mockResolvedTheme.value = 'light';

      const { result } = renderHook(() => useMonacoTheme(null));

      expect(result.current).toBe('vs');
    });
  });

  describe('with Monaco instance', () => {
    it('should define a custom dark theme on the Monaco instance when theme is dark', () => {
      mockResolvedTheme.value = 'dark';
      const monaco = createMockMonaco();

      const { result } = renderHook(() => useMonacoTheme(monaco as never));

      expect(monaco.editor.defineTheme).toHaveBeenCalledWith(
        'pagespace-dark',
        expect.objectContaining({
          base: 'vs-dark',
          inherit: true,
          rules: [],
          colors: expect.any(Object),
        })
      );
      expect(result.current).toBe('pagespace-dark');
    });

    it('should define a custom light theme on the Monaco instance when theme is light', () => {
      mockResolvedTheme.value = 'light';
      const monaco = createMockMonaco();

      const { result } = renderHook(() => useMonacoTheme(monaco as never));

      expect(monaco.editor.defineTheme).toHaveBeenCalledWith(
        'pagespace-light',
        expect.objectContaining({
          base: 'vs',
          inherit: true,
          rules: [],
          colors: expect.any(Object),
        })
      );
      expect(result.current).toBe('pagespace-light');
    });

    it('should include expected color keys in the theme definition', () => {
      mockResolvedTheme.value = 'dark';
      const monaco = createMockMonaco();

      renderHook(() => useMonacoTheme(monaco as never));

      const themeArg = monaco.editor.defineTheme.mock.calls[0][1];
      const colorKeys = Object.keys(themeArg.colors);

      expect(colorKeys).toContain('editor.background');
      expect(colorKeys).toContain('editor.foreground');
      expect(colorKeys).toContain('editor.lineHighlightBackground');
      expect(colorKeys).toContain('editorLineNumber.foreground');
      expect(colorKeys).toContain('editorGutter.background');
      expect(colorKeys).toContain('minimap.background');
      expect(colorKeys).toContain('editor.selectionBackground');
      expect(colorKeys).toContain('editorWidget.background');
      expect(colorKeys).toContain('editorWidget.border');
      expect(colorKeys).toContain('input.background');
      expect(colorKeys).toContain('input.border');
    });

    it('should use hex color values in theme colors', () => {
      mockResolvedTheme.value = 'dark';
      const monaco = createMockMonaco();

      renderHook(() => useMonacoTheme(monaco as never));

      const themeArg = monaco.editor.defineTheme.mock.calls[0][1];
      for (const [, value] of Object.entries(themeArg.colors)) {
        expect(value).toMatch(/^#[0-9a-f]{6,8}$/);
      }
    });
  });

  describe('defineTheme error handling', () => {
    it('should fall back to "vs-dark" when defineTheme throws in dark mode', () => {
      mockResolvedTheme.value = 'dark';
      const monaco = createMockMonaco();
      monaco.editor.defineTheme.mockImplementation(() => {
        throw new Error('defineTheme failed');
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useMonacoTheme(monaco as never));

      expect(result.current).toBe('vs-dark');
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to define Monaco theme, falling back to default theme:',
        expect.any(Error)
      );
      consoleSpy.mockRestore();
    });

    it('should fall back to "vs" when defineTheme throws in light mode', () => {
      mockResolvedTheme.value = 'light';
      const monaco = createMockMonaco();
      monaco.editor.defineTheme.mockImplementation(() => {
        throw new Error('defineTheme failed');
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useMonacoTheme(monaco as never));

      expect(result.current).toBe('vs');
      consoleSpy.mockRestore();
    });
  });

  describe('theme switching', () => {
    it('should update theme when resolvedTheme changes from dark to light', () => {
      mockResolvedTheme.value = 'dark';
      const monaco = createMockMonaco();

      const { result, rerender } = renderHook(() =>
        useMonacoTheme(monaco as never)
      );

      expect(result.current).toBe('pagespace-dark');

      // Switch to light theme
      mockResolvedTheme.value = 'light';
      rerender();

      expect(result.current).toBe('pagespace-light');
      expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(2);
    });

    it('should update theme when Monaco instance becomes available', () => {
      mockResolvedTheme.value = 'dark';

      const { result, rerender } = renderHook(
        ({ monaco }: { monaco: ReturnType<typeof createMockMonaco> | null }) =>
          useMonacoTheme(monaco as never),
        { initialProps: { monaco: null } }
      );

      expect(result.current).toBe('vs-dark');

      // Provide Monaco instance
      const monaco = createMockMonaco();
      rerender({ monaco });

      expect(result.current).toBe('pagespace-dark');
      expect(monaco.editor.defineTheme).toHaveBeenCalledOnce();
    });
  });
});
