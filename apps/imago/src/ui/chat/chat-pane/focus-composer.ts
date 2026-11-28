/** Puts the caret in the composer inside `host`, after any draft already there, so typing goes straight on. */
export function focusComposerAtEnd(host: ParentNode | null): void {
  const field = host?.querySelector<HTMLTextAreaElement>('textarea');
  if (!field) return;
  field.focus();
  const end = field.value.length;
  field.setSelectionRange(end, end);
}
