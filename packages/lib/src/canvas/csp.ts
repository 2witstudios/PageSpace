/** Asset/font directives shared by every canvas/published CSP variant. */
const ASSET_CSP_PREFIX =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;";

/**
 * Builds the canvas baseline CSP, optionally scoping `form-action`/`connect-src`
 * to a single origin so a published Canvas page's <form> (see
 * `../forms/form-html.ts`) can submit to the app's own public forms endpoint.
 *
 * With no origin, behavior is unchanged from the original constant:
 * `form-action 'none'` and no `connect-src` directive at all (so `fetch()`
 * stays blocked by `default-src 'none'`). Never widens to a wildcard — only
 * ever the single origin passed in.
 */
export function buildBaselineCsp(formActionOrigin?: string): string {
  const base = `${ASSET_CSP_PREFIX} script-src 'unsafe-inline'; object-src 'none'; base-uri 'none';`;

  if (!formActionOrigin) {
    return `${base} form-action 'none'`;
  }

  return `${base} form-action 'self' ${formActionOrigin}; connect-src ${formActionOrigin}`;
}

/**
 * Builds the CSP for published DOCUMENT pages (see `../publish/render-document-page.ts`).
 * Unlike canvas pages, documents never run author scripts — the sanitizer
 * (`sanitizeDocumentHtml`) already strips `<script>` tags, and this policy is
 * the hard enforcement layer: `script-src 'none'` blocks any that slip
 * through, and `form-action 'none'` blocks form submission entirely (the
 * sanitizer also strips `<form>`). Every other baseline directive (asset/
 * font/image hosts, `object-src`, `base-uri`) is unchanged from
 * `buildBaselineCsp()`.
 */
export function buildDocumentCsp(): string {
  return `${ASSET_CSP_PREFIX} script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}
