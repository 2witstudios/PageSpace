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

  it('handles a quoted attribute value containing > in a dashboard anchor', () => {
    assert({
      given: 'a dashboard anchor with a quoted attribute containing >',
      should: 'neutralize the whole anchor without corrupting the markup',
      actual: neutralizeDashboardLinks(
        '<a href="/dashboard/d/p" title="2 > 1" data-mention-type="page" data-page-id="p">x</a>',
      ),
      expected: '<span data-mention-type="page" data-page-id="p">x</span>',
    });
  });

  it('handles a single-quoted attribute value containing > in a dashboard anchor', () => {
    assert({
      given: "a dashboard anchor with a single-quoted attribute containing >",
      should: 'neutralize the whole anchor without corrupting the markup',
      actual: neutralizeDashboardLinks(
        "<a href='/dashboard/d/p' title='2 > 1'>x</a>",
      ),
      expected: '<span>x</span>',
    });
  });

  it('leaves a non-dashboard anchor with a quoted > byte-identical', () => {
    const html = '<a href="/pricing" title="2 > 1">pricing</a>';
    assert({
      given: 'a non-dashboard anchor with a quoted attribute containing >',
      should: 'leave it byte-identical',
      actual: neutralizeDashboardLinks(html),
      expected: html,
    });
  });

  it('ignores an href-lookalike inside another attribute quoted value (false positive)', () => {
    const html = '<a title="a > b, see href=/dashboard/d/x" href="/pricing">go</a>';
    assert({
      given: 'a live /pricing anchor whose title text merely mentions href=/dashboard/…',
      should: 'leave it byte-identical instead of destroying the link',
      actual: neutralizeDashboardLinks(html),
      expected: html,
    });
  });

  it('finds the real dashboard href despite an href-lookalike in an earlier attribute (false negative)', () => {
    assert({
      given: 'a dashboard anchor whose title contains a decoy href=https://… before the real href',
      should: 'neutralize using the real href attribute',
      actual: neutralizeDashboardLinks(
        '<a title="old href=https://example.com" href="/dashboard/d/p">@Page</a>',
      ),
      expected: '<span>@Page</span>',
    });
  });

  it('does not fabricate mention attributes from text inside another attribute value', () => {
    assert({
      given: 'a dashboard anchor whose title text contains data-page-id=fake',
      should: 'emit a span without the fabricated attribute',
      actual: neutralizeDashboardLinks(
        '<a href="/dashboard/d/p" title="x > data-page-id=fake">@P</a>',
      ),
      expected: '<span>@P</span>',
    });
  });

  it('leaves a tag with a bare quote in attribute-name position unchanged', () => {
    // A browser's tokenizer ends this tag at the first '>' (quotes only open a
    // value after '='), so matching past it would delete rendered text.
    const html = '<a href="/dashboard/d/p" "x > y">text</a>';
    assert({
      given: 'an anchor with a stray quoted token where an attribute name belongs',
      should: 'leave the region byte-identical',
      actual: neutralizeDashboardLinks(html),
      expected: html,
    });
  });

  it('never lets an unclosed attribute quote swallow content across tags', () => {
    const html =
      "<a href='/dashboard/d/p' title='broken>middle</a><p>It's here>tail</a>";
    assert({
      given: 'an unclosed quote that could pair with an apostrophe in later text',
      should: 'leave the whole region byte-identical instead of deleting elements',
      actual: neutralizeDashboardLinks(html),
      expected: html,
    });
  });

  it('does not steal the closing tag of the next anchor for a self-closed dashboard anchor', () => {
    const html = '<a href="/dashboard/d/p"/>gap <a href="#f">f</a>';
    assert({
      given: 'a self-closed dashboard anchor followed by a valid fragment anchor',
      should: 'leave everything byte-identical rather than unbalancing the markup',
      actual: neutralizeDashboardLinks(html),
      expected: html,
    });
  });

  it('neutralizes a dashboard anchor nested inside an unclosed non-dashboard anchor', () => {
    assert({
      given: 'an unclosed /pricing anchor followed by a well-formed dashboard anchor',
      should: 'still neutralize the dashboard anchor',
      actual: neutralizeDashboardLinks(
        '<a href="/pricing">keep <a href="/dashboard/d/p">dead</a>',
      ),
      expected: '<a href="/pricing">keep <span>dead</span>',
    });
  });

  it('trims whitespace padding from the href before classifying', () => {
    assert({
      given: 'a dashboard href padded with whitespace (browsers strip URL attribute padding)',
      should: 'still neutralize it',
      actual: neutralizeDashboardLinks('<a href=" /dashboard/d/p">x</a>'),
      expected: '<span>x</span>',
    });
  });

  it('handles an unquoted dashboard href', () => {
    assert({
      given: 'an anchor whose href value is unquoted',
      should: 'neutralize it',
      actual: neutralizeDashboardLinks('<a href=/dashboard/d/p>x</a>'),
      expected: '<span>x</span>',
    });
  });

  it('stays fast on pathological unclosed-anchor input', () => {
    const html = '<a href="/dashboard/d/p">x'.repeat(40_000);
    const start = performance.now();
    neutralizeDashboardLinks(html);
    const elapsed = performance.now() - start;
    assert({
      given: '~1MB of repeated dashboard anchor openings with no closing tags',
      should: 'complete in linear time (well under a second)',
      actual: elapsed < 1000,
      expected: true,
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
