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
  const base =
    "default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none';";

  if (!formActionOrigin) {
    return `${base} form-action 'none'`;
  }

  return `${base} form-action 'self' ${formActionOrigin}; connect-src ${formActionOrigin}`;
}
