import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { Search } from 'lucide-react';
import { renderCheckbox } from '../../components/checkbox/checkbox.render';
import { Icon } from '../../components/icon/icon';
import type { IconName } from '../../components/icon/icon-names';
import type { PaletteSearch } from '../use-palette-search/use-palette-search';
import {
  paletteDriveClass,
  paletteFieldClass,
  paletteInputClass,
  paletteLayerClass,
  paletteListClass,
  paletteNoteClass,
  paletteRowClass,
  paletteScopeClass,
  paletteSheetClass,
  paletteTitleClass,
} from './palette-class';

/** A result as the palette draws it. */
export type PaletteRow = {
  readonly id: string;
  readonly title: string;
  readonly icon: IconName;
  /** The drive's name, shown while searching every drive; null otherwise or when it is not listed. */
  readonly driveName: string | null;
};

export type PaletteRenderProps = {
  readonly open: boolean;
  readonly query: string;
  readonly allDrives: boolean;
  /** What the field searches, for its placeholder: the open drive's name, or every drive. */
  readonly scope: string;
  readonly status: PaletteSearch['status'];
  readonly rows: readonly PaletteRow[];
  /** The highlighted row. */
  readonly active: number;
  /** Prefix for the list's and rows' ids, unique on the page. */
  readonly idPrefix: string;
  readonly inputRef?: Ref<HTMLInputElement> | undefined;
  /** Void actions. */
  readonly typeQuery: (query: string) => void;
  readonly toggleAllDrives: () => void;
  readonly move: (by: number) => void;
  readonly pick: (index: number) => void;
  readonly hover: (index: number) => void;
  readonly close: () => void;
};

const noteFor = (status: PaletteSearch['status'], count: number, scope: string): string | null => {
  if (status === 'idle') return `Type to search ${scope}`;
  if (status === 'loading') return 'Searching…';
  if (status === 'error') return 'Search failed. Try again.';
  return count === 0 ? 'No matches' : null;
};

/** Tab and Shift-Tab cycle the sheet's own controls: the palette is modal. */
const keepFocusInside = (event: KeyboardEvent<HTMLElement>): void => {
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input, button')];
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (first === undefined || last === undefined) return;
  const leaving = event.shiftKey ? document.activeElement === first : document.activeElement === last;
  if (!leaving) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus();
};

/**
 * The ⌘K palette (IMG-10.2): a modal search over the drive, or every drive.
 * The field is a combobox over the results listbox, so the highlight moves
 * with the arrows while focus stays in the field; Enter opens the
 * highlighted result and Escape closes.
 */
export function renderPalette(props: PaletteRenderProps): ReactNode {
  const { open, query, allDrives, scope, status, rows, active, idPrefix, inputRef } = props;
  const { typeQuery, toggleAllDrives, move, pick, hover, close } = props;
  if (!open) return null;
  const listId = `${idPrefix}-results`;
  const optionId = (index: number) => `${idPrefix}-result-${index}`;
  // A shorter answer than the highlight reaches starts again at its top.
  const highlighted = rows.length === 0 ? -1 : active < rows.length ? active : 0;
  const note = noteFor(status, rows.length, scope);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (highlighted >= 0) pick(highlighted);
    } else if (event.key === 'Tab') {
      keepFocusInside(event);
    }
  };

  return (
    <div
      className={paletteLayerClass}
      data-palette=""
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="Search" className={paletteSheetClass} onKeyDown={onKeyDown}>
        <div className={paletteFieldClass}>
          <Search size={16} strokeWidth={1.5} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search pages"
            aria-autocomplete="list"
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-activedescendant={highlighted >= 0 ? optionId(highlighted) : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder={`Search ${scope}…`}
            className={paletteInputClass}
            onChange={(event) => typeQuery(event.currentTarget.value)}
          />
          <span className={paletteScopeClass}>
            {renderCheckbox({ checked: allDrives, label: 'Include all workspaces', toggle: toggleAllDrives })}
            <span aria-hidden="true">All workspaces</span>
          </span>
        </div>
        <ul id={listId} role="listbox" aria-label="Results" className={paletteListClass}>
          {rows.map((row, index) => (
            <li
              key={row.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === highlighted}
              className={paletteRowClass(index === highlighted)}
              onMouseMove={() => hover(index)}
              onClick={() => pick(index)}
            >
              <Icon name={row.icon} />
              <span className={paletteTitleClass}>{row.title}</span>
              {row.driveName === null ? null : <span className={paletteDriveClass}>{row.driveName}</span>}
            </li>
          ))}
        </ul>
        <p role="status" className={note === null ? 'sr-only' : paletteNoteClass}>
          {note ?? `${rows.length} ${rows.length === 1 ? 'result' : 'results'}`}
        </p>
      </div>
    </div>
  );
}
