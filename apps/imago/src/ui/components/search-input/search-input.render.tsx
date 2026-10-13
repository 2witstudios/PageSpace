import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { searchFieldClass, searchInputClass } from './search-input-class';

export type SearchInputRenderProps = {
  readonly value: string;
  readonly placeholder: string;
  /** Required accessible name of the searchbox. */
  readonly label: string;
  /** Void action: commits the typed query. */
  readonly typeSearchQuery: (query: string) => void;
};

/**
 * A controlled searchbox. Escape clears a query; on an empty field it is
 * left to bubble, so the surrounding pane can use it.
 */
export function renderSearchInput({
  value,
  placeholder,
  label,
  typeSearchQuery,
}: SearchInputRenderProps): ReactNode {
  return (
    <label className={searchFieldClass}>
      <Search size={16} strokeWidth={1.5} aria-hidden="true" />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        className={searchInputClass}
        onChange={(event) => typeSearchQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || value === '') return;
          event.preventDefault();
          typeSearchQuery('');
        }}
      />
    </label>
  );
}
