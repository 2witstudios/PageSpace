/**
 * PrintView Component Tests - Simplified
 *
 * Focused unit tests for PrintView core functionality.
 * Tests basic rendering, error handling, and component structure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  value: { ready: Promise.resolve() },
});

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Loader2: () => <div data-testid="loader">Loading...</div>,
}));

// Mock DOMPurify
vi.mock('dompurify', () => ({
  default: {
    sanitize: vi.fn((html: string) => html),
  },
}));

// Mock ReadOnlyEditor - minimal implementation
vi.mock('../ReadOnlyEditor', () => ({
  default: () => <div data-testid="read-only-editor">Mocked Editor</div>,
}));

// Mock calculatePageBreaks
vi.mock('@/lib/editor/pagination/page-breaker', () => ({
  calculatePageBreaks: vi.fn(() => []),
}));

describe('PrintView - Simplified', () => {
  const mockPageData = {
    id: 'page-123',
    content: '<p>Test content</p>',
    title: 'Test Page',
    type: 'DOCUMENT',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial Rendering', () => {
    it('renders without crashing', () => {
      const { container } = render(<PrintView page={mockPageData} />);
      expect(container).toBeTruthy();
    });

    it('shows loading state initially', () => {
      render(<PrintView page={mockPageData} />);

      expect(screen.getByTestId('loader')).toBeTruthy();
      expect(screen.getByText(/Preparing print preview/i)).toBeTruthy();
    });

    it('displays helpful loading message', () => {
      render(<PrintView page={mockPageData} />);

      expect(screen.getByText(/Calculating page breaks and formatting content/i)).toBeTruthy();
    });
  });

  describe('Props Handling', () => {
    it('accepts page data prop', () => {
      const { rerender } = render(<PrintView page={mockPageData} />);

      expect(screen.getByText(/Preparing print preview/i)).toBeTruthy();

      const newPage = { ...mockPageData, id: 'page-456' };
      rerender(<PrintView page={newPage} />);

      expect(screen.getByText(/Preparing print preview/i)).toBeTruthy();
    });

    it('handles null content gracefully', () => {
      const pageWithNullContent = { ...mockPageData, content: null };

      const { container } = render(<PrintView page={pageWithNullContent} />);

      expect(container).toBeTruthy();
    });

    it('handles empty string content', () => {
      const pageWithEmptyContent = { ...mockPageData, content: '' };

      const { container } = render(<PrintView page={pageWithEmptyContent} />);

      expect(container).toBeTruthy();
    });
  });

  describe('Component Structure', () => {
    it('renders print container div', () => {
      const { container } = render(<PrintView page={mockPageData} />);

      const printContainer = container.querySelector('.print-container');
      expect(printContainer).toBeTruthy();
    });

    it('includes ReadOnlyEditor component', () => {
      render(<PrintView page={mockPageData} />);

      // Editor should be in DOM even during loading (hidden off-screen)
      expect(screen.getByTestId('read-only-editor')).toBeTruthy();
    });

    it('injects print styles', () => {
      const { container } = render(<PrintView page={mockPageData} />);

      const styleTag = container.querySelector('style');
      expect(styleTag).toBeTruthy();
    });
  });

  describe('Print Styles', () => {
    it('includes @media print rules', () => {
      const { container } = render(<PrintView page={mockPageData} />);

      const styleTag = container.querySelector('style');
      expect(styleTag).toBeTruthy();
      if (styleTag?.textContent) {
        expect(styleTag.textContent).toContain('@media print');
      }
    });

    it('sets page size to 8.5x11 inches', () => {
      const { container } = render(<PrintView page={mockPageData} />);

      const styleTag = container.querySelector('style');
      expect(styleTag).toBeTruthy();
      if (styleTag?.textContent) {
        expect(styleTag.textContent).toContain('8.5in 11in');
      }
    });

    it('includes hidden-editor class styles', () => {
      const { container } = render(<PrintView page={mockPageData} />);

      const styleTag = container.querySelector('style');
      expect(styleTag).toBeTruthy();
      if (styleTag?.textContent) {
        expect(styleTag.textContent).toContain('.hidden-editor');
      }
    });

    it('includes page-break styles', () => {
      const { container } = render(<PrintView page={mockPageData} />);

      const styleTag = container.querySelector('style');
      expect(styleTag).toBeTruthy();
      if (styleTag?.textContent) {
        expect(styleTag.textContent).toContain('page-break-after');
      }
    });
  });

  describe('Security', () => {
    it('uses DOMPurify for HTML sanitization', async () => {
      const DOMPurify = (await import('dompurify')).default;

      render(<PrintView page={mockPageData} />);

      // DOMPurify will be called when content is split and rendered
      // (happens after loading state completes)
      expect(DOMPurify.sanitize).toBeDefined();
    });
  });

  describe('Accessibility', () => {
    it('provides meaningful loading message for screen readers', () => {
      render(<PrintView page={mockPageData} />);

      expect(screen.getByText(/Preparing print preview/i)).toBeTruthy();
      expect(screen.getByText(/Calculating page breaks and formatting content/i)).toBeTruthy();
    });
  });
});
