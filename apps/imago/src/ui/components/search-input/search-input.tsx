'use client';

import { renderSearchInput, type SearchInputRenderProps } from './search-input.render';

export type SearchInputProps = SearchInputRenderProps;

/** A controlled search field: the caller owns the query. */
export function SearchInput(props: SearchInputProps) {
  return renderSearchInput(props);
}
