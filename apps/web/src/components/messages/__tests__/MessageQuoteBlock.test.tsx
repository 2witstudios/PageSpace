import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MessageQuoteBlock from '../MessageQuoteBlock';
import type { QuotedMessageSnapshot } from '@pagespace/lib/services/quote-enrichment';

vi.mock('@/hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigateToPage: vi.fn() }),
}));

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  const message = `Given ${given}, should ${should}`;
  expect(actual, message).toEqual(expected);
};

const activeQuote = (overrides: Partial<QuotedMessageSnapshot> = {}): QuotedMessageSnapshot => ({
  id: 'q1',
  authorId: 'user-1',
  authorName: 'Alice',
  authorImage: null,
  contentSnippet: 'I think we should ship it on Friday.',
  createdAt: new Date('2026-05-04T12:00:00Z'),
  isActive: true,
  ...overrides,
});

describe('MessageQuoteBlock — tombstone branch', () => {
  it('renders the tombstone when quoted is null', () => {
    render(<MessageQuoteBlock quoted={null} />);
    assert({
      given: 'a null quote (e.g. quotedMessageId pointed at a hard-deleted row)',
      should: 'render the tombstone instead of nothing so the embed slot stays visually accounted for',
      actual: screen.getByTestId('message-quote-tombstone').textContent,
      expected: 'Original message deleted',
    });
  });

  it('renders the tombstone when the snapshot is soft-deleted', () => {
    render(<MessageQuoteBlock quoted={activeQuote({ isActive: false })} />);
    assert({
      given: 'a soft-deleted source (isActive: false)',
      should: 'render the tombstone — the renderer, not the query, is what hides deleted content',
      actual: screen.queryByTestId('message-quote-tombstone') !== null,
      expected: true,
    });
  });
});

describe('MessageQuoteBlock — active branch', () => {
  it('shows the author name and snippet text', () => {
    render(<MessageQuoteBlock quoted={activeQuote()} />);
    assert({
      given: 'an active quote with a known author',
      should: 'render the author name and the snippet body',
      actual: {
        author: screen.getByText('Alice') !== null,
        snippet: screen.getByText(/I think we should ship it on Friday/) !== null,
      },
      expected: { author: true, snippet: true },
    });
  });

  it('renders inline mentions inside the snippet via MessagePartRenderer rather than as raw markdown', () => {
    const quoted = activeQuote({
      contentSnippet: 'cc @[Bob](user-2:user) please review',
    });
    render(<MessageQuoteBlock quoted={quoted} />);
    const tombstone = screen.queryByTestId('message-quote-tombstone');
    assert({
      given: 'a snippet containing the @[label](id:type) mention syntax',
      should: 'render through MessagePartRenderer (no tombstone, no raw @[...] visible)',
      actual: {
        tombstone: tombstone !== null,
        rawSyntaxHidden: !screen.queryByText(/@\[Bob\]\(user-2:user\)/),
      },
      expected: { tombstone: false, rawSyntaxHidden: true },
    });
  });
});

describe('MessageQuoteBlock — jump interaction', () => {
  it('calls onJumpToOriginal with the quoted id when clicked', () => {
    const onJump = vi.fn();
    render(<MessageQuoteBlock quoted={activeQuote()} onJumpToOriginal={onJump} />);
    fireEvent.click(screen.getByTestId('message-quote-block'));
    assert({
      given: 'a click on the quote block when onJumpToOriginal is provided',
      should: 'invoke the handler with the quoted message id',
      actual: { calls: onJump.mock.calls.length, arg: onJump.mock.calls[0]?.[0] },
      expected: { calls: 1, arg: 'q1' },
    });
  });

  it('does not expose itself as a button when no jump handler is provided', () => {
    render(<MessageQuoteBlock quoted={activeQuote()} />);
    const block = screen.getByTestId('message-quote-block');
    assert({
      given: 'no onJumpToOriginal prop',
      should: 'render plainly without role=button or tabIndex (read-only embed)',
      actual: { role: block.getAttribute('role'), tabIndex: block.getAttribute('tabindex') },
      expected: { role: null, tabIndex: null },
    });
  });
});
