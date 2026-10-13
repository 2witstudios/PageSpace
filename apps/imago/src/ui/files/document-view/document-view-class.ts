/* A document opened as the object: its header, then the reading column. */
export const documentViewClass = 'flex h-full w-full min-w-0 flex-col';

/* The path above the title, in the pane header: each ancestor a link, the page itself last. */
export const documentCrumbsClass = 'flex min-w-0 items-center gap-1 text-sm font-normal text-ink-muted';

export const documentCrumbClass = 'flex min-w-0 items-center gap-1';

export const documentCrumbLinkClass = 'truncate hover:text-ink';

export const documentCrumbCurrentClass = 'truncate text-ink';

/* Only the body scrolls; the header stays. */
export const documentScrollClass = 'min-h-0 flex-1 overflow-y-auto px-8 py-6';

/* The centred reading column a document sits in (myimago's max-w-doc). */
export const documentColumnClass = 'mx-auto flex w-full max-w-doc flex-col gap-4';

export const documentTitleClass = 'text-doc-title leading-tight font-bold tracking-doc-title text-ink';

/*
 * The ProseMirror root. TipTap's own stylesheet is not injected (it carries no
 * CSP nonce), so the root keeps what it would set: wrapping as written.
 */
export const documentBodyClass =
  'flex min-w-0 flex-col gap-3 text-md leading-normal break-words whitespace-pre-wrap text-ink outline-none';

/*
 * Each document node and mark in imago's tokens. The theme resets every
 * browser default, and arbitrary child selectors are off the token lock, so
 * the reader puts these classes on the nodes themselves as view-only
 * decorations: the document schema is untouched.
 */
export const documentProseClasses = {
  h1: 'mt-4 text-2xl leading-tight font-bold',
  h2: 'mt-3 text-xl leading-tight font-semibold',
  h3: 'mt-2 text-lg leading-tight font-semibold',
  h4: 'text-md font-semibold',
  ul: 'flex list-disc flex-col gap-1 pl-6',
  ol: 'flex list-decimal flex-col gap-1 pl-6',
  taskList: 'flex flex-col gap-1',
  taskItem: 'flex items-start gap-2',
  blockquote: 'border-l-quote border-accent pl-4 text-ink-muted',
  codeBlock: 'overflow-x-auto rounded-lg bg-surface-sunken p-3 font-mono text-sm whitespace-pre',
  hr: 'border-hairline',
  /** On TipTap's scrolling wrapper around the table (border-collapse inherits). */
  table: 'overflow-x-auto border-collapse text-sm',
  cell: 'border border-hairline px-2 py-1 text-left align-top',
  headerCell: 'border border-hairline px-2 py-1 text-left align-top font-semibold',
  /** A file image: the schema holds a file id, never a URL, so it shows its alt text. */
  image: 'rounded-md bg-surface-sunken px-1 text-sm text-ink-muted',
  mention: 'text-accent hover:text-accent-strong',
  link: 'text-accent underline underline-offset-2 hover:text-accent-strong',
  code: 'rounded-sm bg-surface-sunken px-1 font-mono text-sm',
  highlight: 'rounded-sm bg-accent-soft',
} as const;
