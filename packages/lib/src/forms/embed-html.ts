function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerBlock(formTargetId: string, block: string): string {
  return `<!-- pagespace:form:${formTargetId} start -->\n${block}\n<!-- pagespace:form:${formTargetId} end -->`;
}

export interface EmbedWiredBlockInput {
  content: string;
  /** The original, un-wired <form>...</form> text exactly as it appears in
   *  content (e.g. from parsing content and reading the element's outerHTML). */
  originalFormHtml: string;
  formTargetId: string;
  /** The wired markup for this same form (see wireFormBlock in form-html.ts) —
   *  NOT yet wrapped in marker comments; this function wraps it. */
  wiredFormHtml: string;
}

/**
 * Replaces an original, un-wired <form> tag's exact text in a Canvas page's
 * content with its wired equivalent, wrapped in
 * `<!-- pagespace:form:{id} start/end -->` markers so it can later be found
 * (to display status) or removed (see deleteFormBlock) as a unit.
 *
 * Requires originalFormHtml to appear verbatim in content. Returns null if it
 * doesn't — this can happen if the DOM-parsed outerHTML the caller captured
 * doesn't byte-for-byte match the source text (the browser's HTML parser can
 * normalize attribute quoting, self-closing tags, etc.). Callers should
 * surface that as a failure rather than silently doing nothing.
 */
export function embedWiredBlock({
  content,
  originalFormHtml,
  formTargetId,
  wiredFormHtml,
}: EmbedWiredBlockInput): string | null {
  if (!content.includes(originalFormHtml)) {
    return null;
  }
  return content.replace(originalFormHtml, markerBlock(formTargetId, wiredFormHtml));
}

export interface DeleteFormBlockInput {
  content: string;
  formTargetId: string;
}

/**
 * Removes a wired form's entire marker-wrapped block — its <form> tag and
 * injected honeypot/script — from a Canvas page's content. Used when
 * archiving a form via the Forms tab, so the page doesn't end up with a
 * dead, permanently-404ing form tag left behind. A no-op (returns content
 * unchanged) if the markers aren't found — e.g. already removed, or hand-
 * edited away.
 */
export function deleteFormBlock({ content, formTargetId }: DeleteFormBlockInput): string {
  const escapedId = escapeRegExp(formTargetId);
  const pattern = new RegExp(
    `<!-- pagespace:form:${escapedId} start -->[\\s\\S]*?<!-- pagespace:form:${escapedId} end -->\\n*`
  );
  return content.replace(pattern, '');
}
