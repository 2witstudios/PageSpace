/* The composer stays at the foot of the object pane while the thread
   scrolls above it. */
export const postComposerClass = 'sticky bottom-0 flex flex-col gap-1 pt-2 pb-4';

/** PageSpace's composer card: a soft border that firms up while typing, and the ambient lift. */
export const postComposerEntryClass =
  'flex items-end gap-2 rounded-xl border border-border bg-surface-raised p-2 shadow-ambient transition-colors duration-120 ease-standard focus-within:border-border-strong';

/** The field: plain text, the UI size, three lines before it scrolls. */
export const postComposerFieldClass =
  'h-16 flex-1 resize-none border-none bg-transparent px-2 py-1 text-base text-ink outline-none placeholder:text-ink-faint';

/** Send: the accent circle in light, quiet in dark; faded while there is nothing to send. */
export const postComposerSendClass =
  'flex size-control flex-none cursor-pointer items-center justify-center rounded-round bg-send text-send-ink transition-colors duration-120 ease-standard disabled:cursor-default disabled:opacity-50';

/** Why the last post did not go. */
export const postComposerErrorClass = 'px-2 text-xs text-warn';
