import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { TrackedMention } from '@/hooks/useMentionTracker';

import { MentionHighlightOverlay } from '../MentionHighlightOverlay';

describe('MentionHighlightOverlay', () => {
  describe('text rendering', () => {
    it('given plain text with no mentions, should render text in spans', () => {
      render(<MentionHighlightOverlay value="hello world" mentions={[]} />);

      expect(screen.getByText('hello world')).toBeInTheDocument();
    });

    it('given empty string, should render zero-width space', () => {
      const { container } = render(<MentionHighlightOverlay value="" mentions={[]} />);

      expect(container.textContent).toBe('\u200B');
    });

    it('given a single page mention, should render formatted @label', () => {
      const mentions: TrackedMention[] = [
        { start: 0, end: 8, label: 'My Page', id: 'abc123', type: 'page' },
      ];
      render(<MentionHighlightOverlay value="@My Page" mentions={mentions} />);

      const mention = screen.getByText('@My Page');
      expect(mention).toBeInTheDocument();
      expect(mention).toHaveClass('text-primary', 'underline');
    });

    it('given a single user mention, should render formatted @label', () => {
      const mentions: TrackedMention[] = [
        { start: 0, end: 6, label: 'Alice', id: 'user1', type: 'user' },
      ];
      render(<MentionHighlightOverlay value="@Alice" mentions={mentions} />);

      const mention = screen.getByText('@Alice');
      expect(mention).toBeInTheDocument();
      expect(mention).toHaveClass('text-primary', 'underline');
    });

    it('given mixed content with multiple mention types, should render all segments correctly', () => {
      const mentions: TrackedMention[] = [
        { start: 6, end: 10, label: 'Doc', id: 'id1', type: 'page' },
        { start: 15, end: 19, label: 'Bob', id: 'id2', type: 'user' },
      ];
      const { container } = render(
        <MentionHighlightOverlay value="Hello @Doc and @Bob bye" mentions={mentions} />
      );

      const overlay = container.firstElementChild!;
      const spans = overlay.querySelectorAll('span');
      // Expect: "Hello ", "@Doc", " and ", "@Bob", " bye"
      expect(spans).toHaveLength(5);
      expect(spans[0].textContent).toBe('Hello ');
      expect(spans[1].textContent).toBe('@Doc');
      expect(spans[2].textContent).toBe(' and ');
      expect(spans[3].textContent).toBe('@Bob');
      expect(spans[4].textContent).toBe(' bye');
    });

    it('given multiple page mentions, should render each with correct label', () => {
      const mentions: TrackedMention[] = [
        { start: 0, end: 6, label: 'First', id: 'id1', type: 'page' },
        { start: 12, end: 19, label: 'Second', id: 'id2', type: 'page' },
      ];
      render(
        <MentionHighlightOverlay value="@First then @Second" mentions={mentions} />
      );

      expect(screen.getByText('@First')).toBeInTheDocument();
      expect(screen.getByText('@Second')).toBeInTheDocument();
    });
  });

  describe('container attributes', () => {
    it('given rendered overlay, should have aria-hidden="true"', () => {
      const { container } = render(<MentionHighlightOverlay value="test" mentions={[]} />);

      const overlay = container.firstElementChild;
      expect(overlay).toHaveAttribute('aria-hidden', 'true');
    });

    it('given rendered overlay, should have correct base classes', () => {
      const { container } = render(<MentionHighlightOverlay value="test" mentions={[]} />);

      const overlay = container.firstElementChild;
      expect(overlay).toHaveClass(
        'absolute',
        'inset-0',
        'pointer-events-none',
        'overflow-hidden',
        'whitespace-pre-wrap'
      );
    });

    it('given custom className, should merge with base classes', () => {
      const { container } = render(
        <MentionHighlightOverlay value="test" mentions={[]} className="px-3 py-2 custom-class" />
      );

      const overlay = container.firstElementChild;
      expect(overlay).toHaveClass('absolute', 'pointer-events-none', 'custom-class');
    });

    it('given a ref, should forward to the container div', () => {
      const ref = React.createRef<HTMLDivElement>();
      render(<MentionHighlightOverlay ref={ref} value="test" mentions={[]} />);

      expect(ref.current).toBeInstanceOf(HTMLDivElement);
      expect(ref.current).toHaveAttribute('aria-hidden', 'true');
    });
  });
});
