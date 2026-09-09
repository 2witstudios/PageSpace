// @vitest-environment node
//
// Runs under `node`, NOT this package's default `jsdom` environment, for two
// reasons. The practical one: esbuild refuses to start under jsdom, whose
// `TextEncoder` does not return a real `Uint8Array`. The better one: the Node
// half of this comparison must parse through happy-dom explicitly, and an
// ambient jsdom `document` in scope is exactly the accident that could make it
// silently do something else.
/**
 * The same source HTML must yield the same ProseMirror document under the Node
 * DOM shim (happy-dom) and under a real browser.
 *
 * **This is the highest-impact unknown in the whole conversion core, and it is
 * a hard blocker rather than a nice-to-have.** Several `parseHTML` functions in
 * the frozen schema read the *DOM*, not the source string:
 * `TextStyleKit`'s `getStyleProperty` fallbacks, `MarkdownTightLists`'
 * `!element.querySelector('p')`, `CodeBlockNode`'s `element.querySelector('code')`.
 * DOM implementations disagree about exactly those things — jsdom canonicalises
 * `'Times New Roman'` to `"Times New Roman"` and reorders `style` declarations;
 * happy-dom and Chromium need not agree either.
 *
 * So `SCHEMA_HASH` can be identical in two processes while the PARSE diverges.
 * That is not a cosmetic difference: it means the collab server and the browser
 * disagree about what a document *is*, for a document neither of them changed.
 * `SCHEMA_HASH` cannot catch it — it hashes the schema's shape, and
 * `parseHTML` is its documented blind spot. Only this comparison can.
 *
 * Needs Chromium: `bunx playwright install chromium`. It deliberately does NOT
 * skip when the browser is absent — a cross-DOM check that quietly reports
 * green on a machine with no second DOM is worse than no check at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as esbuild from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { htmlToPmDoc } from '../html-to-ydoc.js';
import { CORPUS_CASES, corpusDocumentHtml } from './support/construct-corpus.js';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  const bundle = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('./support/cross-dom-browser-entry.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
  });

  browser = await chromium.launch();
  page = await browser.newPage();
  // `setContent` rather than a file:// or http:// URL: the parse under test
  // needs a document, not a server, and no network makes the comparison
  // reproducible.
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
}, 120_000);

// Explicit timeout: vitest's DEFAULT hook timeout is 10s, and closing Chromium
// under a loaded full-suite `test:coverage` run exceeded it — the suite's 28
// tests all passed and the FILE still failed. That failure mode is invisible to
// a `Tests N passed` summary, and `test:coverage` is exactly what CI runs.
afterAll(async () => {
  await browser?.close();
}, 60_000);

async function parseInBrowser(html: string): Promise<unknown> {
  return page.evaluate((source: string) => {
    const parse = window.__parseHtmlToPmJson;
    if (!parse) {
      throw new Error('browser entry bundle did not install __parseHtmlToPmJson');
    }
    return parse(source);
  }, html);
}

describe('cross-DOM parse equality', () => {
  it('installed the browser harness', async () => {
    // Guards the comparison itself: if the bundle silently failed to evaluate,
    // every `page.evaluate` below would throw rather than pass — but a future
    // edit that made `parseInBrowser` fall back to anything would not, and this
    // states the precondition rather than leaving it implicit.
    expect(await page.evaluate(() => typeof window.__parseHtmlToPmJson)).toBe('function');
  });

  it.each(CORPUS_CASES)(
    'agrees with Chromium on %s',
    async (_key, fixture) => {
      expect(await parseInBrowser(fixture.html)).toEqual(htmlToPmDoc(fixture.html).toJSON());
    },
  );

  it('agrees with Chromium on the whole corpus as one document', async () => {
    const html = corpusDocumentHtml();
    expect(await parseInBrowser(html)).toEqual(htmlToPmDoc(html).toJSON());
  });

  it('agrees on a style declaration written in a dialect a DOM may rewrite', async () => {
    // The specific divergence the leaf names: single-quoted font families,
    // shorthand colours and declaration ORDER are all things a DOM
    // implementation may canonicalise on its way into `element.style`, and
    // `TextStyleKit` reads `element.style`, not the attribute text.
    const html =
      '<p><span style="font-size:14px;font-family:\'Times New Roman\',serif;color:#F00">x</span></p>';
    expect(await parseInBrowser(html)).toEqual(htmlToPmDoc(html).toJSON());
  });

  it('agrees on list tightness, which is inferred from the DOM tree', async () => {
    // `MarkdownTightLists` calls `element.querySelector('p')`. Two DOMs that
    // build the tree differently — over an implied `<tbody>`, an unclosed
    // `<li>`, or whitespace text nodes — would answer differently.
    const html = '<ul><li>bare<li>second</ul><ul><li><p>wrapped</p></li></ul>';
    expect(await parseInBrowser(html)).toEqual(htmlToPmDoc(html).toJSON());
  });

  it('agrees on a table written without an explicit tbody', async () => {
    const html = '<table><tr><th>H</th></tr><tr><td>c</td></tr></table>';
    expect(await parseInBrowser(html)).toEqual(htmlToPmDoc(html).toJSON());
  });
});
