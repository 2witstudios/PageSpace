import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { TrackedMention } from '@/hooks/useMentionTracker';

const { mockNavigateToPage } = vi.hoisted(() => ({
  mockNavigateToPage: vi.fn(),
}));

vi.mock('@/hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigateToPage: mockNavigateToPage }),
}));

import { MentionHighlightOverlay } from '../MentionHighlightOverlay';

describe('MentionHighlightOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
      expect(mention).toHaveClass('font-semibold', 'text-primary');
    });

    it('given a single user mention, should render formatted @label', () => {
      const mentions: TrackedMention[] = [
        { start: 0, end: 6, label: 'Alice', id: 'user1', type: 'user' },
      ];
      render(<MentionHighlightOverlay value="@Alice" mentions={mentions} />);

      const mention = screen.getByText('@Alice');
      expect(mention).toBeInTheDocument();
      expect(mention).toHaveClass('font-semibold', 'text-primary');
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

  describe('page mention interaction', () => {
    it('given a page mention, should have role="link" and pointer-events-auto', () => {
      const mentions: TrackedMention[] = [
        { start: 0, end: 8, label: 'My Page', id: 'abc123', type: 'page' },
      ];
      render(<MentionHighlightOverlay value="@My Page" mentions={mentions} />);

      const mention = screen.getByRole('link', { hidden: true });
      expect(mention).toHaveClass('pointer-events-auto');
    });

    it('given a page mention mousedown, should call navigateToPage with correct id', () => {
      const mentions: TrackedMention[] = [
        { start: 0, end: 8, label: 'My Page', id: 'abc123', type: 'page' },
      ];
      render(<MentionHighlightOverlay value="@My Page" mentions={mentions} />);

      const mention = screen.getByRole('link', { hidden: true });
      // fireEvent.mouseDown is needed since the handler is onMouseDown, not onClick
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'preventDefault', { value: vi.fn() });
      Object.defineProperty(event, 'stopPropagation', { value: vi.fn() });
      mention.dispatchEvent(event);

      expect(mockNavigateToPage).toHaveBeenCalledWith('abc123');
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('given multiple page mentions, should navigate to correct id for each', () => {
      const mentions: TrackedMention[] = [
        { start: 0, end: 6, label: 'First', id: 'id1', type: 'page' },
        { start: 11, end: 18, label: 'Second', id: 'id2', type: 'page' },
      ];
      render(
        <MentionHighlightOverlay value="@First and @Second" mentions={mentions} />
      );

      const links = screen.getAllByRole('link', { hidden: true });
      expect(links).toHaveLength(2);

      // Click first mention
      const event1 = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      links[0].dispatchEvent(event1);
      expect(mockNavigateToPage).toHaveBeenCalledWith('id1');

      // Click second mention
      const event2 = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      links[1].dispatchEvent(event2);
      expect(mockNavigateToPage).toHaveBeenCalledWith('id2');
    });
  });

  describe('user mention interaction', () => {
    it('given a user mention, should NOT have role="link"', () => {
      const mentions: TrackedMention[] = [
        { start: 0, end: 6, label: 'Alice', id: 'user1', type: 'user' },
      ];
      render(<MentionHighlightOverlay value="@Alice" mentions={mentions} />);

      expect(screen.queryByRole('link', { hidden: true })).not.toBeInTheDocument();
    });

    it('given a user mention, should NOT have pointer-events-auto class', () => {
      const mentions: TrackedMention[] = [
        { start: 0, end: 6, label: 'Alice', id: 'user1', type: 'user' },
      ];
      render(<MentionHighlightOverlay value="@Alice" mentions={mentions} />);

      const mention = screen.getByText('@Alice');
      expect(mention).not.toHaveClass('pointer-events-auto');
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
