import { describe, it, expect } from 'vitest';

import { neutralizeDashboardLinks } from '../neutralize-dashboard-links';

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

describe('neutralizeDashboardLinks', () => {
  it('converts a dashboard mention anchor into a span', () => {
    assert({
      given: 'an anchor whose href is a relative /dashboard/ path',
      should: 'replace the anchor with a span preserving the inner HTML',
      actual: neutralizeDashboardLinks(
        '<p><a href="/dashboard/drive1/page1" class="mention" data-mention-type="page" data-page-id="page1">@My Page</a></p>',
      ),
      expected:
        '<p><span data-mention-type="page" data-page-id="page1">@My Page</span></p>',
    });
  });

  it('preserves data-mention-type and data-page-id in source order', () => {
    assert({
      given: 'an anchor with data-page-id before data-mention-type',
      should: 'carry both attributes onto the span in their original order',
      actual: neutralizeDashboardLinks(
        '<a data-page-id="p9" href="/dashboard/d/p9" data-mention-type="page">@Nine</a>',
      ),
      expected: '<span data-page-id="p9" data-mention-type="page">@Nine</span>',
    });
  });

  it('drops non-mention attributes from the neutralized span', () => {
    assert({
      given: 'an anchor with class, target, and rel attributes',
      should: 'emit a span carrying only the mention data attributes',
      actual: neutralizeDashboardLinks(
        '<a href="/dashboard/d/p" class="mention" target="_blank" rel="noopener" data-mention-type="page" data-page-id="p">@Page</a>',
      ),
      expected: '<span data-mention-type="page" data-page-id="p">@Page</span>',
    });
  });

  it('neutralizes a dashboard anchor without mention data attributes', () => {
    assert({
      given: 'a plain dashboard anchor with no data attributes',
      should: 'replace it with a bare span around the inner HTML',
      actual: neutralizeDashboardLinks('<a href="/dashboard/d/p">go</a>'),
      expected: '<span>go</span>',
    });
  });

  it('handles single-quoted href values', () => {
    assert({
      given: "an anchor whose href uses single quotes",
      should: 'still neutralize it',
      actual: neutralizeDashboardLinks(
        "<a href='/dashboard/d/p' data-mention-type='page' data-page-id='p'>@P</a>",
      ),
      expected: '<span data-mention-type="page" data-page-id="p">@P</span>',
    });
  });

  it('preserves nested markup inside the anchor', () => {
    assert({
      given: 'an anchor containing nested inline markup',
      should: 'keep the nested markup inside the span',
      actual: neutralizeDashboardLinks(
        '<a href="/dashboard/d/p"><strong>bold</strong> and <em>italic</em></a>',
      ),
      expected: '<span><strong>bold</strong> and <em>italic</em></span>',
    });
  });

  it('leaves published absolute URLs byte-identical', () => {
    const html =
      '<a href="https://mysite.pagespace.site/about" data-mention-type="page" data-page-id="p2">@About</a>';
    assert({
      given: 'an anchor already rewritten to a public https URL',
      should: 'leave it byte-identical',
      actual: neutralizeDashboardLinks(html),
      expected: html,
    });
  });

  it('leaves same-page fragment links byte-identical', () => {
    const html = '<a href="#section-2">jump</a>';
    assert({
      given: 'a same-page fragment anchor',
      should: 'leave it byte-identical',
      actual: neutralizeDashboardLinks(html),
      expected: html,
    });
  });

  it('leaves non-dashboard relative links byte-identical', () => {
    const html = '<a href="/pricing">pricing</a> <a href="mailto:a@b.c">mail</a>';
    assert({
      given: 'relative and mailto anchors that are not dashboard links',
      should: 'leave them byte-identical',
      actual: neutralizeDashboardLinks(html),
      expected: html,
    });
  });

  it('does not treat an absolute dashboard URL as a leftover in-app link', () => {
    const html = '<a href="https://pagespace.ai/dashboard/d/p">@Page</a>';
    assert({
      given: 'an anchor whose href is an absolute URL containing /dashboard/',
      should: 'leave it byte-identical (only relative /dashboard/ paths are dead)',
      actual: neutralizeDashboardLinks(html),
      expected: html,
    });
  });

  it('does not match paths that merely contain /dashboard/ mid-path', () => {
    const html = '<a href="/docs/dashboard/setup">docs</a>';
    assert({
      given: 'an anchor whose relative href contains /dashboard/ but does not start with it',
      should: 'leave it byte-identical',
      actual: neutralizeDashboardLinks(html),
      expected: html,
    });
  });

  it('neutralizes only the dashboard anchors in mixed content', () => {
    assert({
      given: 'a document mixing dashboard, published, and fragment anchors',
      should: 'neutralize only the dashboard ones',
      actual: neutralizeDashboardLinks(
        '<a href="/dashboard/d/p1" data-mention-type="page" data-page-id="p1">@One</a>' +
          '<a href="https://s.pagespace.site/two">two</a>' +
          '<a href="/dashboard/d/p3">three</a>' +
          '<a href="#top">top</a>',
      ),
      expected:
        '<span data-mention-type="page" data-page-id="p1">@One</span>' +
        '<a href="https://s.pagespace.site/two">two</a>' +
        '<span>three</span>' +
        '<a href="#top">top</a>',
    });
  });

  it('leaves an unclosed dashboard anchor unchanged without throwing', () => {
    const html = '<p><a href="/dashboard/d/p">never closed</p>';
    assert({
      given: 'a malformed anchor with no closing tag',
      should: 'leave the malformed region unchanged',
      actual: neutralizeDashboardLinks(html),
      expected: html,
    });
  });

  it('still neutralizes well-formed anchors after a malformed one', () => {
    assert({
      given: 'a malformed anchor followed by a well-formed dashboard anchor',
      should: 'neutralize the well-formed one and leave the rest intact',
      actual: neutralizeDashboardLinks(
        '<a href="/dashboard/d/broken <a href="/dashboard/d/p">ok</a>',
      ),
      expected: '<a href="/dashboard/d/broken <span>ok</span>',
    });
  });

  it('tolerates an anchor with no href', () => {
    const html = '<a name="anchor-target">legacy</a>';
    assert({
      given: 'an anchor without an href attribute',
      should: 'leave it byte-identical',
      actual: neutralizeDashboardLinks(html),
      expected: html,
    });
  });

  it('is idempotent', () => {
    const input =
      '<p><a href="/dashboard/d/p" data-mention-type="page" data-page-id="p">@P</a> and <a href="#x">x</a></p>';
    const once = neutralizeDashboardLinks(input);
    assert({
      given: 'already-neutralized output run through the transform again',
      should: 'return it unchanged',
      actual: neutralizeDashboardLinks(once),
      expected: once,
    });
  });

  it('returns empty input unchanged', () => {
    assert({
      given: 'an empty string',
      should: 'return an empty string',
      actual: neutralizeDashboardLinks(''),
      expected: '',
    });
  });
});
