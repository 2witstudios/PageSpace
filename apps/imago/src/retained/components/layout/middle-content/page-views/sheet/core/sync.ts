/**
 * Pure server-sync predicate for the sheet view. The socket handler receives a
 * fresh `page:content-updated` payload; this decides whether to adopt it. Local
 * unsaved edits always win — a dirty document ignores server content until saved.
 */
export const shouldApplyServerContent = (
  incomingContent: string,
  currentContent: string,
  isDirty: boolean,
): boolean => incomingContent !== currentContent && !isDirty;
