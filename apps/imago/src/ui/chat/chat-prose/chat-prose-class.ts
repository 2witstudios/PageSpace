/**
 * Markdown elements in a chat message. The imago theme resets every default
 * (theme/reset.css), so the prose names its own tokens: paragraphs and lists
 * in the message's own size, code in a sunken block, links in the accent.
 */
export const proseClasses = {
  root: 'flex min-w-0 flex-col gap-3 break-words',
  heading: 'font-semibold',
  strong: 'font-semibold',
  ul: 'list-disc pl-6',
  ol: 'list-decimal pl-6',
  blockquote: 'border-l-2 border-hairline pl-3 text-ink-muted',
  code: 'rounded-sm bg-surface-sunken px-1 font-mono text-sm',
  pre: 'overflow-x-auto rounded-lg bg-surface-sunken p-3 font-mono text-sm',
  a: 'text-accent underline underline-offset-2 hover:text-accent-strong',
  tableWrap: 'min-w-0 overflow-x-auto',
  table: 'border-collapse text-sm',
  cell: 'border border-hairline px-2 py-1 text-left',
} as const;
