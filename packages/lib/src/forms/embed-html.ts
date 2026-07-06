function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerBlock(formTargetId: string, html: string): string {
  return `<!-- pagespace:form:${formTargetId} start -->\n${html}\n<!-- pagespace:form:${formTargetId} end -->`;
}

export interface SpliceFormHtmlInput {
  /** The Canvas page's current raw HTML content. */
  content: string;
  /** The newly provisioned form's ready-to-embed HTML. */
  html: string;
  formTargetId: string;
  /** The form target this one is replacing (e.g. an archived target being
   *  superseded via the Forms tab's "Set up a new form" action). Omitted for
   *  a first-time create. */
  replacesFormTargetId?: string;
}

/**
 * Splices a form's HTML into a Canvas page's content, wrapped in a marker
 * comment pair keyed by formTargetId (`<!-- pagespace:form:{id} start/end -->`).
 *
 * When replacesFormTargetId is given and its marker block is still present,
 * the new block replaces it IN PLACE — the replacement form lands exactly
 * where the old one was, instead of at the end of a page that may have been
 * substantially rearranged since. If the old markers aren't found (hand-
 * edited away, or this is a first-time create), the new block is appended.
 */
export function spliceFormHtml({
  content,
  html,
  formTargetId,
  replacesFormTargetId,
}: SpliceFormHtmlInput): string {
  const block = markerBlock(formTargetId, html);

  if (replacesFormTargetId) {
    const escapedId = escapeRegExp(replacesFormTargetId);
    const oldBlockPattern = new RegExp(
      `<!-- pagespace:form:${escapedId} start -->[\\s\\S]*?<!-- pagespace:form:${escapedId} end -->`
    );
    if (oldBlockPattern.test(content)) {
      return content.replace(oldBlockPattern, block);
    }
  }

  return content ? `${content}\n\n${block}\n` : `${block}\n`;
}
