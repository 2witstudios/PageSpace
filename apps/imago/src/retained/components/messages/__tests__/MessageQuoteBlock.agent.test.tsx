// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import MessageQuoteBlock from '../MessageQuoteBlock';
import type { QuotedMessageSnapshot } from '@pagespace/lib/services/quote-enrichment';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('streamdown', () => ({
  defaultRemarkPlugins: { gfm: () => undefined },
  Streamdown: ({ children }: { children: string }) => <span>{children}</span>,
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

afterEach(cleanup);

describe('MessageQuoteBlock — agent marker (Agent Signup Phase 2c)', () => {
  it('marks a quote whose author is an agent account', () => {
    render(<MessageQuoteBlock quoted={activeQuote({ authorName: 'PageSpace Support', authorAccountType: 'agent' })} />);
    assert({
      given: 'a quote of an agent-authored message',
      should: 'render the agent marker beside the (unchanged) author name',
      actual: {
        name: screen.getByText('PageSpace Support').textContent,
        marked: screen.queryByLabelText('AI agent account') !== null,
      },
      expected: { name: 'PageSpace Support', marked: true },
    });
  });

  it('leaves a human or unknown author unmarked', () => {
    for (const authorAccountType of ['human', null, undefined]) {
      const { unmount } = render(<MessageQuoteBlock quoted={activeQuote({ authorAccountType })} />);
      assert({
        given: `a quote whose author accountType is ${String(authorAccountType)}`,
        should: 'render no agent marker',
        actual: screen.queryByLabelText('AI agent account'),
        expected: null,
      });
      unmount();
    }
  });
});
