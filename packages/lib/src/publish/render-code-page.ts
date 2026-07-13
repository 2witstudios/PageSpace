import { escapeHtml } from '../utils/html';
import { renderDocumentShell, wrapDocumentBody } from './document-shell';

export interface RenderCodePageInput {
  code: string;
  title: string;
  lang?: string;
}

/**
 * Render a CODE page as a static, standalone HTML document. No syntax
 * highlighting (Shiki is client-side in this repo) — the raw code string is
 * HTML-escaped and emitted verbatim inside `<pre><code>`, so it can never
 * carry live markup. Head assembly and CSP (`script-src 'none'`) are
 * delegated to `document-shell.ts`, the same shell path DOCUMENT pages use.
 */
export function renderCodePage({ code, title, lang }: RenderCodePageInput): string {
  const bodyHtml = wrapDocumentBody({
    bodyHtml: `<pre><code>${escapeHtml(code ?? '')}</code></pre>`,
    title,
  });
  return renderDocumentShell({ title, bodyHtml, lang });
}
