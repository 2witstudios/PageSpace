/* The title, editable in place: the document title's type on a bare input. */
export const documentTitleInputClass =
  'w-full min-w-0 bg-transparent text-doc-title leading-tight font-bold tracking-doc-title text-ink outline-none placeholder:text-ink-muted';

/* How the last save stands, quiet under the title. */
export const documentSaveStateClass = 'min-h-4 text-xs text-ink-muted';

/* A save that needs the viewer: a conflict, a refusal or a failure. */
export const documentNoticeClass =
  'flex flex-col gap-2 rounded-lg border border-hairline bg-surface-sunken p-3 text-sm text-ink';

export const documentNoticeActionsClass = 'flex flex-wrap gap-2';
