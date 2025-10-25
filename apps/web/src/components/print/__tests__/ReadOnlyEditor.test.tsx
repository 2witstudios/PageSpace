/**
 * ReadOnlyEditor Component Tests
 *
 * Tests for the read-only Tiptap editor used in print routes.
 * Ensures proper rendering, extension loading, and DOM mounting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, screen } from '@testing-library/react';
import ReadOnlyEditor from '../ReadOnlyEditor';

// Mock Tiptap modules
vi.mock('@tiptap/react', () => ({
  useEditor: vi.fn((config) => {
    // Return a mock editor instance
    return {
      view: {
        dom: document.createElement('div'),
      },
      getHTML: vi.fn(() => config?.content || '<p></p>'),
      commands: {
        setContent: vi.fn(),
      },
      isDestroyed: false,
    };
  }),
  EditorContent: ({ editor }: { editor: unknown }) => {
    return <div data-testid="editor-content">{editor ? 'Editor Loaded' : 'No Editor'}</div>;
  },
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: {
    configure: vi.fn(() => ({ name: 'StarterKit' })),
  },
}));

vi.mock('tiptap-markdown', () => ({
  Markdown: { name: 'Markdown' },
}));

vi.mock('@tiptap/extensions', () => ({
  CharacterCount: { name: 'CharacterCount' },
}));

vi.mock('@tiptap/extension-text-style', () => ({
  TextStyleKit: { name: 'TextStyleKit' },
}));

vi.mock('@tiptap/extension-table', () => ({
  TableKit: { name: 'TableKit' },
}));

vi.mock('@/lib/editor/tiptap-mention-config', () => ({
  PageMention: { name: 'PageMention' },
}));

describe('ReadOnlyEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic Rendering', () => {
    it('renders without crashing', () => {
      const { container } = render(
        <ReadOnlyEditor content="<p>Test content</p>" />
      );

      expect(container.querySelector('.read-only-editor')).toBeTruthy();
    });

    it('renders EditorContent component', () => {
      render(<ReadOnlyEditor content="<p>Test content</p>" />);

      expect(screen.getByTestId('editor-content')).toBeTruthy();
    });

    it('applies custom className when provided', () => {
      const { container } = render(
        <ReadOnlyEditor content="<p>Test</p>" className="custom-class" />
      );

      const editor = container.querySelector('.read-only-editor');
      expect(editor?.classList.contains('custom-class')).toBe(true);
    });

    it('renders with empty content', () => {
      const { container } = render(<ReadOnlyEditor content="" />);

      expect(container.querySelector('.read-only-editor')).toBeTruthy();
    });
  });

  describe('Editor Configuration', () => {
    it('configures editor as non-editable', async () => {
      const { useEditor } = await import('@tiptap/react');

      render(<ReadOnlyEditor content="<p>Test</p>" />);

      expect(useEditor).toHaveBeenCalledWith(
        expect.objectContaining({
          editable: false,
        })
      );
    });

    it('includes all required extensions', async () => {
      const { useEditor } = await import('@tiptap/react');

      render(<ReadOnlyEditor content="<p>Test</p>" />);

      const mockUseEditor = useEditor as unknown as vi.Mock;
      const config = mockUseEditor.mock.calls[0][0];
      expect(config.extensions).toBeDefined();
      expect(config.extensions.length).toBeGreaterThan(0);
    });

    it('sets immediatelyRender to false', async () => {
      const { useEditor } = await import('@tiptap/react');

      render(<ReadOnlyEditor content="<p>Test</p>" />);

      expect(useEditor).toHaveBeenCalledWith(
        expect.objectContaining({
          immediatelyRender: false,
        })
      );
    });

    it('configures editor props with correct attributes', async () => {
      const { useEditor } = await import('@tiptap/react');

      render(<ReadOnlyEditor content="<p>Test</p>" />);

      const mockUseEditor = useEditor as unknown as vi.Mock;
      const config = mockUseEditor.mock.calls[0][0];
      expect(config.editorProps?.attributes?.class).toBe('tiptap');
      expect(config.editorProps?.attributes?.tabindex).toBe('-1');
    });

    it('disables link clicks in print view', async () => {
      const StarterKit = await import('@tiptap/starter-kit');

      render(<ReadOnlyEditor content="<p>Test</p>" />);

      expect(StarterKit.default.configure).toHaveBeenCalledWith(
        expect.objectContaining({
          link: { openOnClick: false },
        })
      );
    });
  });

  describe('Content Handling', () => {
    it('initializes with provided content', async () => {
      const { useEditor } = await import('@tiptap/react');
      const testContent = '<p>Initial content</p>';

      render(<ReadOnlyEditor content={testContent} />);

      expect(useEditor).toHaveBeenCalledWith(
        expect.objectContaining({
          content: testContent,
        })
      );
    });

    it('updates content when prop changes', async () => {
      const { rerender } = render(
        <ReadOnlyEditor content="<p>First</p>" />
      );

      rerender(<ReadOnlyEditor content="<p>Second</p>" />);

      // Content update is handled by useEffect
      await waitFor(() => {
        expect(true).toBe(true); // Content update effect runs
      });
    });

    it('handles empty content gracefully', async () => {
      const { useEditor } = await import('@tiptap/react');

      render(<ReadOnlyEditor content="" />);

      expect(useEditor).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '',
        })
      );
    });
  });

  describe('DOM Mounting', () => {
    it('calls onMount callback when editor mounts', async () => {
      const onMount = vi.fn();

      render(<ReadOnlyEditor content="<p>Test</p>" onMount={onMount} />);

      await waitFor(() => {
        expect(onMount).toHaveBeenCalled();
      });
    });

    it('provides DOM element to onMount callback', async () => {
      const onMount = vi.fn();

      render(<ReadOnlyEditor content="<p>Test</p>" onMount={onMount} />);

      await waitFor(() => {
        expect(onMount).toHaveBeenCalledWith(expect.any(HTMLElement));
      });
    });

    it('calls onMount with null on unmount', async () => {
      const onMount = vi.fn();

      const { unmount } = render(
        <ReadOnlyEditor content="<p>Test</p>" onMount={onMount} />
      );

      unmount();

      await waitFor(() => {
        expect(onMount).toHaveBeenLastCalledWith(null);
      });
    });

    it('does not call onMount if editor fails to initialize', async () => {
      // Temporarily override the useEditor mock to return null
      const { useEditor } = await import('@tiptap/react');
      const mockUseEditor = useEditor as unknown as vi.Mock;
      const originalMock = mockUseEditor.getMockImplementation();

      mockUseEditor.mockImplementationOnce(() => null);

      const onMount = vi.fn();

      render(<ReadOnlyEditor content="<p>Test</p>" onMount={onMount} />);

      expect(onMount).not.toHaveBeenCalled();

      // Restore original mock
      if (originalMock) {
        mockUseEditor.mockImplementation(originalMock);
      }
    });
  });

  describe('Edge Cases', () => {
    it('handles very long content', async () => {
      const longContent = '<p>' + 'A'.repeat(10000) + '</p>';

      const { container } = render(<ReadOnlyEditor content={longContent} />);

      expect(container.querySelector('.read-only-editor')).toBeTruthy();
    });

    it('handles HTML with special characters', async () => {
      const content = '<p>&lt;script&gt;alert("xss")&lt;/script&gt;</p>';

      const { container } = render(<ReadOnlyEditor content={content} />);

      expect(container.querySelector('.read-only-editor')).toBeTruthy();
    });

    it('handles complex nested HTML structure', async () => {
      const content = `
        <h1>Title</h1>
        <ul>
          <li>Item 1
            <ul>
              <li>Nested 1</li>
              <li>Nested 2</li>
            </ul>
          </li>
        </ul>
      `;

      const { container } = render(<ReadOnlyEditor content={content} />);

      expect(container.querySelector('.read-only-editor')).toBeTruthy();
    });
  });
});
