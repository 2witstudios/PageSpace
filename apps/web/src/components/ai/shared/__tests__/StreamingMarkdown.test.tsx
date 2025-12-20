import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock Streamdown with a simple implementation that passes children through
vi.mock('streamdown', () => ({
  Streamdown: ({ children, mode, className }: { children: string; mode: string; className?: string }) => (
    React.createElement('div', { 'data-testid': 'streamdown', 'data-mode': mode, className }, children)
  ),
}));

// Import after mocking
import { StreamingMarkdown } from '../chat/StreamingMarkdown';

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

  describe('deprecated id prop', () => {
    it('should accept id prop without errors (backward compatibility)', () => {
      // Should not throw
      expect(() => {
        render(<StreamingMarkdown content="Hello" id="test-id" />);
      }).not.toThrow();
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
});
