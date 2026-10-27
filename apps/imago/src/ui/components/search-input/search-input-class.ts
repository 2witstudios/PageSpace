/* The field: a glass control capped at the search width, its hairline
   firming on hover and while the input inside has focus. */
export const searchFieldClass =
  'flex max-w-search flex-1 items-center gap-2 rounded-md border border-hairline surface-glass-raised px-3 py-2 text-ink-muted transition-colors duration-120 ease-standard focus-within:border-border-strong hover:border-border-strong';

/* The input: borderless and transparent inside the field. `outline-none`
   leaves the global 3px accent halo (a box-shadow) to mark focus. */
export const searchInputClass =
  'flex-1 border-none bg-transparent px-search-x py-search-y text-xs text-ink outline-none placeholder:text-ink-faint';
