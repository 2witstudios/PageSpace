import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { streamdownSpy } = vi.hoisted(() => ({
  streamdownSpy: vi.fn(),
}));

// Mock Streamdown with a simple implementation that passes children through
vi.mock('streamdown', () => ({
  defaultRemarkPlugins: {
    gfm: () => undefined,
  },
  Streamdown: ({
    children,
    mode,
    className,
    remarkPlugins,
  }: {
    children: string;
    mode: string;
    className?: string;
    remarkPlugins?: unknown[];
  }) => {
    streamdownSpy({ children, mode, className, remarkPlugins });
    return React.createElement('div', { 'data-testid': 'streamdown', 'data-mode': mode, className }, children);
  },
}));

// Import after mocking
import { StreamingMarkdown } from '../chat/StreamingMarkdown';

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

type RemarkTransformer = (tree: MarkdownNode) => void;
type RemarkPlugin = () => RemarkTransformer;

function getLastRemarkPlugins(): RemarkPlugin[] {
  const lastCall = streamdownSpy.mock.lastCall as [{ remarkPlugins?: RemarkPlugin[] }] | undefined;
  return lastCall?.[0].remarkPlugins ?? [];
}

function applyUserHtmlTextPlugin(tree: MarkdownNode): void {
  const remarkPlugins = getLastRemarkPlugins();
  const rawHtmlTextPlugin = remarkPlugins[remarkPlugins.length - 1];

  expect(rawHtmlTextPlugin).toBeTypeOf('function');

  const transform = rawHtmlTextPlugin();
  transform(tree);
}

/**
 * Tests for StreamingMarkdown component
 * Following TDD guidelines from tdd.mdc
 */
describe('StreamingMarkdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering modes', () => {
    it('should render in streaming mode when isStreaming is true', () => {
      render(<StreamingMarkdown content="Hello world" isStreaming={true} />);

      const streamdown = screen.getByTestId('streamdown');
      expect(streamdown).toHaveAttribute('data-mode', 'streaming');
    });

    it('should render in static mode when isStreaming is false', () => {
      render(<StreamingMarkdown content="Hello world" isStreaming={false} />);

      const streamdown = screen.getByTestId('streamdown');
      expect(streamdown).toHaveAttribute('data-mode', 'static');
    });

    it('should default to static mode when isStreaming is not provided', () => {
      render(<StreamingMarkdown content="Hello world" />);

      const streamdown = screen.getByTestId('streamdown');
      expect(streamdown).toHaveAttribute('data-mode', 'static');
    });
  });

  describe('className prop', () => {
    it('should pass className to Streamdown', () => {
      render(<StreamingMarkdown content="Hello" className="custom-class" />);

      const streamdown = screen.getByTestId('streamdown');
      expect(streamdown).toHaveClass('custom-class');
    });
  });

});

describe('preprocessMentions', () => {
  // Test the mention preprocessing through the component rendering
  // We verify the output by checking what content is passed to Streamdown

  it('should convert single mention to Streamdown link format', () => {
    render(<StreamingMarkdown content="Hello @[User](user123:user) world" />);

    const streamdown = screen.getByTestId('streamdown');
    expect(streamdown.textContent).toBe('Hello [mention:User](mention://user123/user) world');
  });

  it('should convert multiple mentions', () => {
    render(
      <StreamingMarkdown content="@[Alice](alice:user) and @[Bob](bob:user) are here" />
    );

    const streamdown = screen.getByTestId('streamdown');
    expect(streamdown.textContent).toBe(
      '[mention:Alice](mention://alice/user) and [mention:Bob](mention://bob/user) are here'
    );
  });

  it('should handle mentions with different types', () => {
    render(
      <StreamingMarkdown content="See @[Project](proj123:page) and @[Team](team456:agent)" />
    );

    const streamdown = screen.getByTestId('streamdown');
    expect(streamdown.textContent).toBe(
      'See [mention:Project](mention://proj123/page) and [mention:Team](mention://team456/agent)'
    );
  });

  it('should not modify content without mentions', () => {
    render(<StreamingMarkdown content="Hello world, no mentions here!" />);

    const streamdown = screen.getByTestId('streamdown');
    expect(streamdown.textContent).toBe('Hello world, no mentions here!');
  });

  it('should handle empty content', () => {
    render(<StreamingMarkdown content="" />);

    const streamdown = screen.getByTestId('streamdown');
    expect(streamdown.textContent).toBe('');
  });

  it('should handle content with only a mention', () => {
    render(<StreamingMarkdown content="@[SingleMention](id:type)" />);

    const streamdown = screen.getByTestId('streamdown');
    expect(streamdown.textContent).toBe('[mention:SingleMention](mention://id/type)');
  });

  it('should handle mentions with special characters in label', () => {
    render(<StreamingMarkdown content="@[User Name](id:type)" />);

    const streamdown = screen.getByTestId('streamdown');
    expect(streamdown.textContent).toBe('[mention:User Name](mention://id/type)');
  });

  it('should handle consecutive calls correctly (regex state)', () => {
    // First render
    const { rerender } = render(<StreamingMarkdown content="@[First](id1:type)" />);
    expect(screen.getByTestId('streamdown').textContent).toBe('[mention:First](mention://id1/type)');

    // Second render - regex lastIndex should be reset
    rerender(<StreamingMarkdown content="@[Second](id2:type)" />);
    expect(screen.getByTestId('streamdown').textContent).toBe('[mention:Second](mention://id2/type)');
  });
});

describe('raw HTML rendering', () => {
  it('should keep raw user markdown source intact while installing an HTML-to-text remark plugin', () => {
    render(
      React.createElement(
        StreamingMarkdown as React.ComponentType<{ content: string; renderHtmlAsText?: boolean }>,
        {
          content: 'Write a <style> block inside <html>',
          renderHtmlAsText: true,
        }
      )
    );

    const streamdown = screen.getByTestId('streamdown');
    expect(streamdown.textContent).toBe('Write a <style> block inside <html>');

    const tree: MarkdownNode = {
      type: 'root',
      children: [
        { type: 'text', value: 'Write a ' },
        { type: 'html', value: '<style>' },
        { type: 'text', value: ' block inside ' },
        { type: 'html', value: '<html>' },
      ],
    };

    applyUserHtmlTextPlugin(tree);

    expect(tree.children).toEqual([
      { type: 'text', value: 'Write a ' },
      { type: 'text', value: '<style>' },
      { type: 'text', value: ' block inside ' },
      { type: 'text', value: '<html>' },
    ]);
  });

  it('should preserve mention preprocessing without escaping the raw markdown source', () => {
    render(
      React.createElement(
        StreamingMarkdown as React.ComponentType<{ content: string; renderHtmlAsText?: boolean }>,
        {
          content: 'See <style> and @[Project](proj123:page)',
          renderHtmlAsText: true,
        }
      )
    );

    const streamdown = screen.getByTestId('streamdown');
    expect(streamdown.textContent).toBe(
      'See <style> and [mention:Project](mention://proj123/page)'
    );
  });

  it('should leave inline code and autolink nodes untouched when converting raw HTML nodes to text', () => {
    render(
      React.createElement(
        StreamingMarkdown as React.ComponentType<{ content: string; renderHtmlAsText?: boolean }>,
        {
          content: '`<div>` <https://example.com> <style>',
          renderHtmlAsText: true,
        }
      )
    );

    const tree: MarkdownNode = {
      type: 'root',
      children: [
        { type: 'inlineCode', value: '<div>' },
        { type: 'text', value: ' ' },
        {
          type: 'link',
          url: 'https://example.com',
          children: [{ type: 'text', value: 'https://example.com' }],
        },
        { type: 'text', value: ' ' },
        { type: 'html', value: '<style>' },
      ],
    };

    applyUserHtmlTextPlugin(tree);

    expect(tree.children).toEqual([
      { type: 'inlineCode', value: '<div>' },
      { type: 'text', value: ' ' },
      {
        type: 'link',
        url: 'https://example.com',
        children: [{ type: 'text', value: 'https://example.com' }],
      },
      { type: 'text', value: ' ' },
      { type: 'text', value: '<style>' },
    ]);
  });
});

describe('memoization', () => {
  it('should re-render when content changes', () => {
    const { rerender } = render(<StreamingMarkdown content="First" />);
    expect(screen.getByTestId('streamdown').textContent).toBe('First');

    rerender(<StreamingMarkdown content="Second" />);
    expect(screen.getByTestId('streamdown').textContent).toBe('Second');
  });

  it('should re-render when isStreaming changes', () => {
    const { rerender } = render(<StreamingMarkdown content="Test" isStreaming={false} />);
    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-mode', 'static');

    rerender(<StreamingMarkdown content="Test" isStreaming={true} />);
    expect(screen.getByTestId('streamdown')).toHaveAttribute('data-mode', 'streaming');
  });

  it('should re-render when renderHtmlAsText changes', () => {
    const { rerender } = render(
      React.createElement(
        StreamingMarkdown as React.ComponentType<{ content: string; renderHtmlAsText?: boolean }>,
        { content: 'Test', renderHtmlAsText: false }
      )
    );
    expect(getLastRemarkPlugins()).toHaveLength(0);

    rerender(
      React.createElement(
        StreamingMarkdown as React.ComponentType<{ content: string; renderHtmlAsText?: boolean }>,
        { content: 'Test', renderHtmlAsText: true }
      )
    );
    expect(getLastRemarkPlugins().length).toBeGreaterThan(0);
  });
});
