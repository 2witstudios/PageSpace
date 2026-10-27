import { describe, it, expect } from 'vitest';

import { renderSheetPage } from '../render-sheet-page';
import { buildDocumentCsp } from '../../canvas/csp';

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

const GRID = {
  rowCount: 2,
  columnCount: 2,
  cells: { A1: 'Name', B1: 'Age', A2: 'Alice', B2: '30' },
};

describe('renderSheetPage', () => {
  it('should render a static <table> from sheet content', () => {
    const html = renderSheetPage({ serializedContent: GRID, title: 'Roster' });
    assert({
      given: 'a small 2x2 sheet',
      should: 'emit a <table> containing every cell value',
      actual:
        html.includes('<table>') &&
        html.includes('Name') &&
        html.includes('Age') &&
        html.includes('Alice') &&
        html.includes('30'),
      expected: true,
    });
  });

  it('should render the first row as <th> headers when hasHeaders is true', () => {
    const html = renderSheetPage({ serializedContent: GRID, title: 'Roster', hasHeaders: true });
    assert({
      given: 'hasHeaders: true',
      should: 'emit a <thead> with <th>Name</th><th>Age</th> and the rest as <tbody> <td> rows',
      actual:
        html.includes('<thead><tr><th>Name</th><th>Age</th></tr></thead>') &&
        html.includes('<tbody><tr><td>Alice</td><td>30</td></tr></tbody>'),
      expected: true,
    });
  });

  it('should render every row as <td> data when hasHeaders is false/omitted', () => {
    const html = renderSheetPage({ serializedContent: GRID, title: 'Roster' });
    assert({
      given: 'no hasHeaders flag',
      should: 'emit no <thead> and put every row (including the first) in <tbody>',
      actual:
        !html.includes('<thead>') &&
        html.includes('<tbody><tr><td>Name</td><td>Age</td></tr><tr><td>Alice</td><td>30</td></tr></tbody>'),
      expected: true,
    });
  });

  it('should HTML-escape cell text', () => {
    const html = renderSheetPage({
      serializedContent: { rowCount: 1, columnCount: 1, cells: { A1: '<b>x</b> & "y"' } },
      title: 'T',
    });
    assert({
      given: 'a cell containing HTML-special characters',
      should: 'escape them so they render as text, not markup',
      actual: html.includes('<td>&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;</td>'),
      expected: true,
    });
  });

  it('should render the evaluated display value for a formula cell', () => {
    const html = renderSheetPage({
      serializedContent: { rowCount: 1, columnCount: 2, cells: { A1: '5', B1: '=A1*2' } },
      title: 'T',
    });
    assert({
      given: 'a cell holding a formula referencing another cell',
      should: 'render the evaluated result, not the raw formula string',
      actual: html.includes('<td>5</td><td>10</td>') && !html.includes('=A1*2'),
      expected: true,
    });
  });

  it('should render an empty-state message for malformed content, never throwing', () => {
    const malformedInputs: unknown[] = ['{{{not json', null, undefined, 42, ['a', 'b'], {}];
    const results = malformedInputs.map((serializedContent) => {
      try {
        return renderSheetPage({ serializedContent, title: 'T' });
      } catch {
        return 'THREW';
      }
    });
    assert({
      given: 'a variety of malformed/empty sheet contents',
      should: 'never throw, and never emit a <table> (empty-state message instead)',
      actual: results.every((html) => html !== 'THREW' && !html.includes('<table>')),
      expected: true,
    });
  });

  it('should wrap the table inside the shared .ps-document shell with a title header', () => {
    const html = renderSheetPage({ serializedContent: GRID, title: 'My Sheet' });
    assert({
      given: 'a sheet page render',
      should: 'emit <article class="ps-document"> with a <header><h1> title around the table',
      actual: /<article class="ps-document"><header><h1>My Sheet<\/h1><\/header><table>.*<\/table><\/article>/.test(
        html,
      ),
      expected: true,
    });
  });

  it('should delegate head assembly to renderCanvasDocument (doctype, title, typography CSS)', () => {
    const html = renderSheetPage({ serializedContent: GRID, title: 'My Sheet' });
    assert({
      given: 'a sheet page render',
      should: 'produce a full standalone document with the title and inlined document typography CSS',
      actual:
        html.startsWith('<!doctype html>') &&
        html.includes('</html>') &&
        html.includes('<title>My Sheet</title>') &&
        html.includes('.ps-document {') &&
        html.includes('max-width: 42rem'),
      expected: true,
    });
  });

  it('should carry buildDocumentCsp() (script-src none) as the CSP override', () => {
    const html = renderSheetPage({ serializedContent: GRID, title: 'T' });
    assert({
      given: 'a rendered sheet page',
      should: "carry buildDocumentCsp()'s content verbatim in the CSP meta tag",
      actual: html.includes(`content="${buildDocumentCsp()}"`) && html.includes("script-src 'none'"),
      expected: true,
    });
  });

  it('should omit the theme-bridge script', () => {
    assert({
      given: 'a rendered sheet page (standalone, not an in-app iframe)',
      should: 'not inject the theme-bridge <script>',
      actual: renderSheetPage({ serializedContent: GRID, title: 'T' }).includes('pagespace-theme'),
      expected: false,
    });
  });

  it('should never emit a <script> tag, even from malicious cell content', () => {
    const html = renderSheetPage({
      serializedContent: { rowCount: 1, columnCount: 1, cells: { A1: '</table></article></body><script>alert(1)</script>' } },
      title: 'T',
    });
    assert({
      given: 'a cell attempting to break out of the table and inject a script tag',
      should: 'contain no literal <script tag anywhere in the output',
      actual: /<script/i.test(html),
      expected: false,
    });
  });

  it('should emit the canonical link and OG tags when pageUrl is provided', () => {
    const html = renderSheetPage({
      serializedContent: GRID,
      title: 'My Sheet',
      pageUrl: 'https://acme.pagespace.site/sheet',
      ogImageUrl: 'https://acme.pagespace.site/og.png',
      ogDescription: 'A great sheet',
    });
    assert({
      given: 'pageUrl, ogImageUrl and ogDescription',
      should: 'emit a canonical link and OG meta tags (passed through to renderCanvasDocument)',
      actual:
        html.includes('<link rel="canonical" href="https://acme.pagespace.site/sheet">') &&
        html.includes('<meta property="og:image" content="https://acme.pagespace.site/og.png">') &&
        html.includes('<meta property="og:description" content="A great sheet">'),
      expected: true,
    });
  });

  it('should omit the canonical link and OG tags when pageUrl is absent', () => {
    const html = renderSheetPage({ serializedContent: GRID, title: 'T' });
    assert({
      given: 'no pageUrl',
      should: 'omit canonical/OG tags entirely',
      actual: html.includes('rel="canonical"') || html.includes('property="og:'),
      expected: false,
    });
  });
});
