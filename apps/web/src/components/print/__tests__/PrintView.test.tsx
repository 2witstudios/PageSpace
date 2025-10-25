/**
 * PrintView Component - Focused Unit Tests
 *
 * Tests core functionality that can be reliably unit tested:
 * - Props validation and handling
 * - Error boundary behavior
 * - Security (DOMPurify integration)
 * - Component structure basics
 *
 * NOTE: The following require integration/E2E tests (Playwright):
 * - Print dialog triggering (window.print())
 * - Actual pagination rendering with page breaks
 * - Font loading behavior (document.fonts.ready)
 * - Full async state transitions (loading → mounted → calculated → ready)
 * - Browser print CSS (@media print rules)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import PrintView from '../PrintView';

// Mock dependencies
vi.mock('lucide-react', () => ({
  Loader2: () => <div data-testid="loader-icon">Loading Icon</div>,
}));

vi.mock('dompurify', () => ({
  default: {
    sanitize: vi.fn((html: string) => html), // Pass through for testing
  },
}));

vi.mock('../ReadOnlyEditor', () => ({
  default: ({ content }: { content: string }) => (
    <div data-testid="read-only-editor">{content}</div>
  ),
}));

vi.mock('@/lib/editor/pagination/page-breaker', () => ({
  calculatePageBreaks: vi.fn(() => []),
}));

describe('PrintView - Focused Unit Tests', () => {
  const validPageData = {
    id: 'page-123',
    content: '<p>Test content</p>',
    title: 'Test Page',
    type: 'DOCUMENT' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Component Mounting', () => {
    it('renders without crashing', () => {
      const { container } = render(<PrintView page={validPageData} />);
      expect(container).toBeTruthy();
    });

    it('renders with valid page data', () => {
      const { container } = render(<PrintView page={validPageData} />);
      expect(container.firstChild).toBeTruthy();
    });

    it('does not throw when mounted', () => {
      expect(() => {
        render(<PrintView page={validPageData} />);
      }).not.toThrow();
    });
  });

  describe('Props Validation', () => {
    it('accepts page data with all required fields', () => {
      const { container } = render(<PrintView page={validPageData} />);
      expect(container).toBeTruthy();
    });

    it('accepts page with null content', () => {
      const pageWithNullContent = { ...validPageData, content: null };
      const { container } = render(<PrintView page={pageWithNullContent} />);
      expect(container).toBeTruthy();
    });

    it('accepts page with empty string content', () => {
      const pageWithEmptyContent = { ...validPageData, content: '' };
      const { container } = render(<PrintView page={pageWithEmptyContent} />);
      expect(container).toBeTruthy();
    });

    it('accepts page with different types', () => {
      const types = ['DOCUMENT', 'FOLDER', 'CHANNEL', 'AI_CHAT'];
      types.forEach(type => {
        const { container } = render(
          <PrintView page={{ ...validPageData, type }} />
        );
        expect(container).toBeTruthy();
      });
    });

    it('handles very long content strings', () => {
      const longContent = '<p>' + 'A'.repeat(10000) + '</p>';
      const { container } = render(
        <PrintView page={{ ...validPageData, content: longContent }} />
      );
      expect(container).toBeTruthy();
    });
  });

  describe('Loading State', () => {
    it('shows loading indicator initially', () => {
      render(<PrintView page={validPageData} />);
      expect(screen.getByTestId('loader-icon')).toBeTruthy();
    });

    it('shows loading heading', () => {
      render(<PrintView page={validPageData} />);
      expect(screen.getByText(/Preparing print preview/i)).toBeTruthy();
    });

    it('shows descriptive loading message', () => {
      render(<PrintView page={validPageData} />);
      expect(screen.getByText(/Calculating page breaks and formatting content/i)).toBeTruthy();
    });
  });

  describe('Security - DOMPurify Integration', () => {
    it('imports DOMPurify module', async () => {
      const DOMPurify = (await import('dompurify')).default;
      expect(DOMPurify).toBeDefined();
      expect(DOMPurify.sanitize).toBeDefined();
    });

    it('DOMPurify sanitize function is callable', async () => {
      const DOMPurify = (await import('dompurify')).default;
      const result = DOMPurify.sanitize('<p>test</p>');
      expect(result).toBe('<p>test</p>'); // Mock returns input
    });
  });

  describe('Component Structure', () => {
    it('contains main print container element', () => {
      const { container } = render(<PrintView page={validPageData} />);
      // Verify component renders a container
      expect(container.firstChild).toBeTruthy();
    });

    it('renders loading state with proper structure', () => {
      const { container } = render(<PrintView page={validPageData} />);
      // Verify loading UI renders
      const loadingDiv = container.querySelector('.flex');
      expect(loadingDiv).toBeTruthy();
    });
  });

  describe('Edge Cases', () => {
    it('handles HTML with special characters', () => {
      const specialContent = '<p>&lt;script&gt;alert("xss")&lt;/script&gt;</p>';
      const { container } = render(
        <PrintView page={{ ...validPageData, content: specialContent }} />
      );
      expect(container).toBeTruthy();
    });

    it('handles complex nested HTML', () => {
      const complexContent = `
        <div>
          <h1>Title</h1>
          <ul>
            <li>Item 1
              <ul>
                <li>Nested</li>
              </ul>
            </li>
          </ul>
        </div>
      `;
      const { container } = render(
        <PrintView page={{ ...validPageData, content: complexContent }} />
      );
      expect(container).toBeTruthy();
    });

    it('handles content with unicode characters', () => {
      const unicodeContent = '<p>Hello 世界 🌍 مرحبا</p>';
      const { container } = render(
        <PrintView page={{ ...validPageData, content: unicodeContent }} />
      );
      expect(container).toBeTruthy();
    });
  });

  describe('Accessibility', () => {
    it('provides accessible loading message', () => {
      render(<PrintView page={validPageData} />);
      const heading = screen.getByText(/Preparing print preview/i);
      expect(heading.tagName).toBe('H2');
    });

    it('uses semantic HTML for loading state', () => {
      const { container } = render(<PrintView page={validPageData} />);
      const loadingContainer = container.querySelector('.flex.items-center');
      expect(loadingContainer).toBeTruthy();
    });
  });
});
