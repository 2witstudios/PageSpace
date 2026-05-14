import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { convertToMessageParts, renderMessageParts } from '../MessagePartRenderer';
import React from 'react';

vi.mock('@/hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigateToPage: vi.fn() }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/navigation/app-navigation', () => ({
  isInternalUrl: (url: string) => url.startsWith('/'),
  openExternalUrl: vi.fn(),
}));

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  expect(actual, `Given ${given}, should ${should}`).toEqual(expected);
};

function renderText(content: string) {
  const parts = convertToMessageParts(content);
  return render(<div>{renderMessageParts(parts)}</div>);
}

describe('convertToMessageParts', () => {
  it('converts plain string to text part', () => {
    assert({
      given: 'a plain string',
      should: 'produce a single text part',
      actual: convertToMessageParts('hello world'),
      expected: [{ type: 'text', text: 'hello world' }],
    });
  });

  it('converts JSON doc string to rich-text part', () => {
    const doc = '{"type":"doc","content":[]}';
    assert({
      given: 'a JSON doc string',
      should: 'produce a rich-text part',
      actual: convertToMessageParts(doc),
      expected: [{ type: 'rich-text', content: { type: 'doc', content: [] } }],
    });
  });
});

describe('URL auto-linking in text parts', () => {
  it('renders a bare https URL as a clickable anchor', () => {
    renderText('check out https://example.com today');

    const link = screen.getByRole('link', { name: 'https://example.com' });
    assert({
      given: 'a bare https URL in text',
      should: 'render as an anchor with correct href',
      actual: link.getAttribute('href'),
      expected: 'https://example.com',
    });
  });

  it('renders a bare http URL as a clickable anchor', () => {
    renderText('visit http://example.com now');

    const link = screen.getByRole('link', { name: 'http://example.com' });
    assert({
      given: 'a bare http URL in text',
      should: 'render as a clickable link',
      actual: link.getAttribute('href'),
      expected: 'http://example.com',
    });
  });

  it('strips trailing period from URL', () => {
    renderText('see https://example.com.');

    const link = screen.getByRole('link', { name: 'https://example.com' });
    assert({
      given: 'a URL with trailing period',
      should: 'exclude the period from the href',
      actual: link.getAttribute('href'),
      expected: 'https://example.com',
    });

    assert({
      given: 'a URL with trailing period',
      should: 'render the period as plain text after the link',
      actual: link.nextSibling?.textContent,
      expected: '.',
    });
  });

  it('renders plain text before and after the URL correctly', () => {
    renderText('before https://example.com after');

    const link = screen.getByRole('link', { name: 'https://example.com' });
    assert({
      given: 'surrounding text',
      should: 'preserve text before the link',
      actual: link.previousSibling?.textContent,
      expected: 'before ',
    });
    assert({
      given: 'surrounding text',
      should: 'preserve text after the link',
      actual: link.nextSibling?.textContent,
      expected: ' after',
    });
  });

  it('renders multiple URLs in the same message', () => {
    renderText('https://one.com and https://two.com');

    const links = screen.getAllByRole('link');
    assert({
      given: 'two bare URLs',
      should: 'render two anchors',
      actual: links.length,
      expected: 2,
    });
    assert({
      given: 'first URL',
      should: 'have correct href',
      actual: links[0].getAttribute('href'),
      expected: 'https://one.com',
    });
    assert({
      given: 'second URL',
      should: 'have correct href',
      actual: links[1].getAttribute('href'),
      expected: 'https://two.com',
    });
  });
});

describe('mentions and URLs together', () => {
  it('renders both a mention badge and a URL link in the same message', () => {
    renderText('@[Alice](alice123:user) shared https://example.com');

    const link = screen.getByRole('link', { name: 'https://example.com' });
    assert({
      given: 'a mention followed by a URL',
      should: 'render the URL as a link',
      actual: link.getAttribute('href'),
      expected: 'https://example.com',
    });

    const mention = screen.getByText('@Alice');
    assert({
      given: 'a user mention',
      should: 'render as a badge span (not a link)',
      actual: mention.tagName.toLowerCase(),
      expected: 'span',
    });
  });

  it('renders a page mention as a link and a URL as a link', () => {
    renderText('@[Docs](docid:page) see https://external.com');

    const links = screen.getAllByRole('link');
    assert({
      given: 'a page mention and a URL',
      should: 'render two links',
      actual: links.length,
      expected: 2,
    });
  });
});

describe('plain text without URLs', () => {
  it('renders plain text without modification', () => {
    renderText('hello world');

    assert({
      given: 'plain text with no URLs or mentions',
      should: 'render the text as-is',
      actual: screen.getByText('hello world').textContent,
      expected: 'hello world',
    });
  });
});
