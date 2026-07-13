import { escapeHtml } from '../utils/html';

/**
 * Typography for published documents. Published pages carry no app stylesheet
 * (no CSS variables, no Tailwind Preflight), so colors are hardcoded light
 * values with a prefers-color-scheme dark override, and UA element margins
 * are zeroed via a low-specificity :where reset before the sibling rhythm.
 * Every rule is scoped under .ps-document except the :root/body page-canvas
 * rules — this stylesheet is only ever inlined into standalone published
 * documents, and the canvas must follow the color scheme or dark mode would
 * render light text on the browser's white default background. Inlined into
 * <style> by the renderer, same pattern as BASELINE_RESET in
 * canvas/render-document.ts.
 */
export const DOCUMENT_TYPOGRAPHY_CSS = `
:root {
  color-scheme: light dark;
}
body {
  background: #ffffff;
}
.ps-document {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji';
  max-width: 42rem;
  margin: 0 auto;
  padding: 2rem 1rem;
  line-height: 1.65;
  color: #1f2328;
  overflow-wrap: break-word;
  word-wrap: break-word;
  min-width: 0;
}
.ps-document :where(h1, h2, h3, h4, h5, h6, p, ul, ol, li, dl, dd, blockquote, pre, figure, hr, table) {
  margin: 0;
}
.ps-document > * + * {
  margin-top: 0.75em;
}
.ps-document h1 {
  font-size: 2em;
  font-weight: bold;
  line-height: 1.25;
}
.ps-document h2 {
  font-size: 1.5em;
  font-weight: bold;
  line-height: 1.3;
  margin-top: 1.5em;
}
.ps-document h3 {
  font-size: 1.17em;
  font-weight: bold;
  margin-top: 1.25em;
}
.ps-document > header {
  margin-bottom: 2rem;
}
.ps-document ul {
  list-style-type: disc;
  padding-left: 1.5rem;
}
.ps-document ol {
  list-style-type: decimal;
  padding-left: 1.5rem;
}
.ps-document code {
  background-color: #eff1f3;
  color: #24292f;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
  border-radius: 0.25rem;
  padding: 0.15em 0.35em;
}
.ps-document pre {
  background: #f6f8fa;
  color: #24292f;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  padding: 0.75rem 1rem;
  border-radius: 0.5rem;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: anywhere;
  max-width: 100%;
}
.ps-document pre code {
  color: inherit;
  padding: 0;
  background: none;
  font-size: 0.85em;
  white-space: pre-wrap;
  word-break: break-all;
}
.ps-document img {
  max-width: 100%;
  height: auto;
  border-radius: 0.375rem;
}
.ps-document table {
  width: 100%;
  border-collapse: collapse;
  margin: 1rem 0;
}
.ps-document th,
.ps-document td {
  border: 1px solid #d0d7de;
  padding: 0.5rem;
  text-align: left;
}
.ps-document th {
  font-weight: bold;
  background-color: #f6f8fa;
}
.ps-document blockquote {
  border-left: 3px solid #d0d7de;
  margin-left: 1.5rem;
  padding-left: 1rem;
  font-style: italic;
  color: #57606a;
}
.ps-document hr {
  border: none;
  border-top: 2px solid rgba(13, 13, 13, 0.1);
  margin: 2rem 0;
}
.ps-document a {
  color: #0969da;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.ps-document a:hover {
  opacity: 0.8;
}
.ps-document a[data-mention-type],
.ps-document span[data-mention-type] {
  background-color: rgba(9, 105, 218, 0.08);
  border: 1px solid rgba(9, 105, 218, 0.2);
  border-radius: 0.375rem;
  padding: 0.1em 0.35em;
  text-decoration: none;
  font-size: 0.95em;
  white-space: nowrap;
}
.ps-document span[data-mention-type] {
  /* Neutralized mention (target unpublished): span isn't a link, so the anchor's
   * base color/cursor never applies -- restate them here to keep the chip
   * looking identical to a live mention instead of falling back to plain text. */
  color: #0969da;
  cursor: default;
  display: inline-block;
}
@media (prefers-color-scheme: dark) {
  body {
    background: #0d1117;
  }
  .ps-document {
    color: #e6edf3;
  }
  .ps-document code {
    background-color: #2d333b;
    color: #d1d7e0;
  }
  .ps-document pre {
    background: #161b22;
    color: #e6edf3;
  }
  .ps-document th,
  .ps-document td {
    border-color: #3d444d;
  }
  .ps-document th {
    background-color: #21262d;
  }
  .ps-document blockquote {
    border-color: #3d444d;
    color: #9198a1;
  }
  .ps-document hr {
    border-top-color: rgba(255, 255, 255, 0.12);
  }
  .ps-document a {
    color: #4493f8;
  }
  .ps-document a[data-mention-type],
  .ps-document span[data-mention-type] {
    background-color: rgba(68, 147, 248, 0.12);
    border-color: rgba(68, 147, 248, 0.3);
  }
  .ps-document span[data-mention-type] {
    color: #4493f8;
  }
}
`;

/**
 * True when the first meaningful element of the body is an <h1>. Leading
 * whitespace and HTML comments are tolerated; an unterminated comment means
 * no meaningful content follows.
 */
export function documentStartsWithH1(html: string): boolean {
  let rest = html;
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->', 4);
      if (end === -1) return false;
      rest = rest.slice(end + 3);
      continue;
    }
    return /^<h1[\s>]/i.test(rest);
  }
}

export function wrapDocumentBody({ bodyHtml, title }: { bodyHtml: string; title: string }): string {
  const header = documentStartsWithH1(bodyHtml)
    ? ''
    : `<header><h1>${escapeHtml(title)}</h1></header>`;
  return `<article class="ps-document">${header}${bodyHtml}</article>`;
}
