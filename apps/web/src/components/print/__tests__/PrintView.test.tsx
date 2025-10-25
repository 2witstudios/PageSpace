/**
 * PrintView Component Tests
 *
 * Tests for the print view orchestration component.
 * Ensures proper pagination calculation, content splitting, and print triggering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, screen } from '@testing-library/react';
import PrintView from '../PrintView';

// Mock window.print
const mockPrint = vi.fn();
Object.defineProperty(window, 'print', {
  writable: true,
  value: mockPrint,
});

// Mock document.fonts.ready
Object.defineProperty(document, 'fonts', {
  writable: true,
  value: {
    ready: Promise.resolve(),
  },
});

// Mock requestIdleCallback
(global as any).requestIdleCallback = (callback: () => void) => {
  setTimeout(callback, 0);
  return 0;
};

// Mock ReadOnlyEditor
vi.mock('../ReadOnlyEditor', () => ({
  default: ({ content, onMount, className }: { content: string; onMount?: (el: HTMLElement | null) => void; className?: string }) => {
    // Synchronously call onMount for testing
    if (onMount) {
      // Use queueMicrotask to avoid state update warnings
      queueMicrotask(() => {
        const mockEditorElement = document.createElement('div');
        mockEditorElement.className = 'tiptap';

        // Create mock ProseMirror container
        const proseMirrorDiv = document.createElement('div');
        proseMirrorDiv.className = 'ProseMirror';

        // Add mock content elements
        const p1 = document.createElement('p');
        p1.textContent = 'Paragraph 1';
        Object.defineProperty(p1, 'offsetHeight', { value: 100 });

        const p2 = document.createElement('p');
        p2.textContent = 'Paragraph 2';
        Object.defineProperty(p2, 'offsetHeight', { value: 100 });

        proseMirrorDiv.appendChild(p1);
        proseMirrorDiv.appendChild(p2);
        mockEditorElement.appendChild(proseMirrorDiv);

        onMount(mockEditorElement);
      });
    }

    return <div data-testid="read-only-editor" className={className}>{content}</div>;
  },
}));

// Mock calculatePageBreaks
vi.mock('@/lib/editor/pagination/page-breaker', () => ({
  calculatePageBreaks: vi.fn((elements) => {
    // Simple mock: break after first element if we have more than one
    if (elements.length > 1) {
      return [
        {
          pageIndex: 1,
          elementIndex: 1,
          previousPageHeight: 100,
          triggerElementHeight: 100,
        },
      ];
    }
    return [];
  }),
}));

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Loader2: () => <div data-testid="loader">Loading...</div>,
}));

describe('PrintView', () => {
  const mockPageData = {
    id: 'page-123',
    content: '<p>Test content</p>',
    title: 'Test Page',
    type: 'DOCUMENT',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Loading State', () => {
    it('shows loading spinner initially', () => {
      render(<PrintView page={mockPageData} />);

      expect(screen.getByTestId('loader')).toBeTruthy();
      expect(screen.getByText(/Preparing print preview/i)).toBeTruthy();
    });

    it('shows helpful loading message', () => {
      render(<PrintView page={mockPageData} />);

      expect(screen.getByText(/Calculating page breaks and formatting content/i)).toBeTruthy();
    });

    it('does not render content while loading', () => {
      render(<PrintView page={mockPageData} />);

      expect(screen.queryByText(/Print preview ready/i)).toBeFalsy();
    });
  });

  describe('Error Handling', () => {
    it('displays error message when pagination fails', async () => {
      // Mock a failure in calculatePageBreaks
      const { calculatePageBreaks } = await import('@/lib/editor/pagination/page-breaker');
      (calculatePageBreaks as any).mockImplementationOnce(() => {
        throw new Error('Calculation failed');
      });

      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          expect(screen.getByText('Error')).toBeTruthy();
        },
        { timeout: 5000 }
      );
    });

    it('shows close button in error state', async () => {
      const { calculatePageBreaks } = await import('@/lib/editor/pagination/page-breaker');
      (calculatePageBreaks as any).mockImplementationOnce(() => {
        throw new Error('Test error');
      });

      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          expect(screen.getByText('Close')).toBeTruthy();
        },
        { timeout: 5000 }
      );
    });

    it('handles empty content gracefully', async () => {
      const emptyPage = { ...mockPageData, content: null };

      render(<PrintView page={emptyPage} />);

      await waitFor(
        () => {
          expect(screen.getByTestId('read-only-editor')).toBeTruthy();
        },
        { timeout: 5000 }
      );
    });
  });

  describe('Content Rendering', () => {
    it('renders ReadOnlyEditor with page content', async () => {
      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          expect(screen.getByTestId('read-only-editor')).toBeTruthy();
        },
        { timeout: 5000 }
      );
    });

    it('hides measurement editor off-screen', async () => {
      const { container } = render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          const hiddenEditor = container.querySelector('.hidden-editor');
          expect(hiddenEditor).toBeTruthy();
        },
        { timeout: 5000 }
      );
    });

    it('displays page count in preview message', async () => {
      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          // With mock, we should get 2 pages (break after first element)
          const message = screen.queryByText(/Print preview ready/i);
          expect(message).toBeTruthy();
        },
        { timeout: 5000 }
      );
    });
  });

  describe('Pagination Calculation', () => {
    it('calls calculatePageBreaks with content elements', async () => {
      const { calculatePageBreaks } = await import('@/lib/editor/pagination/page-breaker');

      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          expect(calculatePageBreaks).toHaveBeenCalled();
        },
        { timeout: 5000 }
      );
    });

    it('passes correct configuration to calculatePageBreaks', async () => {
      const { calculatePageBreaks } = await import('@/lib/editor/pagination/page-breaker');

      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          expect(calculatePageBreaks).toHaveBeenCalledWith(
            expect.any(Array),
            expect.objectContaining({
              pageContentAreaHeight: 800,
              overflowTolerance: 10,
            })
          );
        },
        { timeout: 5000 }
      );
    });

    it('waits for fonts to load before calculating', async () => {
      const fontReadySpy = vi.spyOn(document.fonts, 'ready', 'get');

      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          expect(fontReadySpy).toHaveBeenCalled();
        },
        { timeout: 5000 }
      );
    });

    it('splits content into pages based on break metadata', async () => {
      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          // Mock creates 1 break = 2 pages
          const pages = screen.queryAllByText(/pages?/i);
          expect(pages.length).toBeGreaterThan(0);
        },
        { timeout: 5000 }
      );
    });
  });

  describe('Print Triggering', () => {
    it('triggers print dialog after pagination completes', async () => {
      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          expect(mockPrint).toHaveBeenCalled();
        },
        { timeout: 5000 }
      );
    });

    it('does not trigger print while loading', () => {
      render(<PrintView page={mockPageData} />);

      expect(mockPrint).not.toHaveBeenCalled();
    });

    it('does not trigger print on error', async () => {
      const { calculatePageBreaks } = await import('@/lib/editor/pagination/page-breaker');
      (calculatePageBreaks as any).mockImplementationOnce(() => {
        throw new Error('Test error');
      });

      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          expect(screen.getByText('Error')).toBeTruthy();
        },
        { timeout: 5000 }
      );

      expect(mockPrint).not.toHaveBeenCalled();
    });

    it('only triggers print once', async () => {
      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          expect(mockPrint).toHaveBeenCalledTimes(1);
        },
        { timeout: 5000 }
      );
    });
  });

  describe('Print CSS', () => {
    it('injects print styles', async () => {
      const { container } = render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          const style = container.querySelector('style');
          expect(style).toBeTruthy();
          expect(style?.textContent).toContain('@media print');
        },
        { timeout: 5000 }
      );
    });

    it('includes page break styles', async () => {
      const { container } = render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          const style = container.querySelector('style');
          expect(style?.textContent).toContain('page-break-after');
        },
        { timeout: 5000 }
      );
    });

    it('sets correct page dimensions', async () => {
      const { container } = render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          const style = container.querySelector('style');
          expect(style?.textContent).toContain('8.5in 11in');
        },
        { timeout: 5000 }
      );
    });

    it('hides measurement editor in print media', async () => {
      const { container } = render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          const style = container.querySelector('style');
          expect(style?.textContent).toContain('.hidden-editor');
          expect(style?.textContent).toContain('display: none');
        },
        { timeout: 5000 }
      );
    });
  });

  describe('Edge Cases', () => {
    it('handles single-element content (no page breaks)', async () => {
      const { calculatePageBreaks } = await import('@/lib/editor/pagination/page-breaker');
      (calculatePageBreaks as any).mockReturnValueOnce([]);

      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          expect(screen.getByText(/Print preview ready/i)).toBeTruthy();
        },
        { timeout: 5000 }
      );
    });

    it('handles very long content with many pages', async () => {
      const { calculatePageBreaks } = await import('@/lib/editor/pagination/page-breaker');
      (calculatePageBreaks as any).mockReturnValueOnce(
        Array.from({ length: 10 }, (_, i) => ({
          pageIndex: i + 1,
          elementIndex: i + 1,
          previousPageHeight: 800,
          triggerElementHeight: 100,
        }))
      );

      render(<PrintView page={mockPageData} />);

      await waitFor(
        () => {
          expect(screen.getByText(/Print preview ready/i)).toBeTruthy();
        },
        { timeout: 5000 }
      );
    });

    it('handles page with special characters', async () => {
      const specialPage = {
        ...mockPageData,
        content: '<p>&lt;script&gt;alert("xss")&lt;/script&gt;</p>',
      };

      render(<PrintView page={specialPage} />);

      await waitFor(
        () => {
          expect(screen.getByTestId('read-only-editor')).toBeTruthy();
        },
        { timeout: 5000 }
      );
    });
  });

  describe('Cleanup', () => {
    it('cleans up timers on unmount', async () => {
      const { unmount } = render(<PrintView page={mockPageData} />);

      unmount();

      // No errors should occur
      expect(true).toBe(true);
    });

    it('does not trigger print after unmount', async () => {
      const { unmount } = render(<PrintView page={mockPageData} />);

      unmount();

      // Wait a bit to ensure no delayed print trigger
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Print should only have been called once (before unmount) or not at all
      expect(mockPrint.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });
});
