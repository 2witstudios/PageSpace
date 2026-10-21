import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { Search } from 'lucide-react';
import { Icon } from '../../components/icon/icon';
import { ImagoOrb } from '../../metal/imago-orb/imago-orb';
import type { IconName } from '../../components/icon/icon-names';
import { matchParts } from '../palette-match/palette-match';
import type { PaletteUser } from '../palette-search/palette-search';
import type { PaletteSearch } from '../use-palette-search/use-palette-search';
import {
  paletteDriveClass,
  paletteFieldClass,
  paletteFooterClass,
  paletteGroupClass,
  paletteGroupLabelClass,
  paletteHintClass,
  paletteHintEndClass,
  paletteInputClass,
  paletteKbdClass,
  paletteLayerClass,
  paletteListClass,
  paletteMatchClass,
  paletteNoteClass,
  paletteRowClass,
  paletteScopeClass,
  paletteScopeOptionClass,
  paletteSearchIconClass,
  paletteSheetClass,
  paletteTextClass,
  paletteTileClass,
  paletteTitleClass,
} from './palette-class';

/** A result as the palette draws it. */
export type PaletteRow = {
  readonly id: string;
  readonly title: string;
  readonly icon: IconName;
  /** Imago's own page: its orb in place of the type icon. */
  readonly imago?: true;
  /** The drive's name, shown while searching every drive; null otherwise or when it is not listed. */
  readonly driveName: string | null;
};

export type PaletteRenderProps = {
  readonly open: boolean;
  readonly query: string;
  readonly allDrives: boolean;
  /** The open drive's name: the switch's first segment, and what the field searches unless every drive is. */
  readonly driveName: string;
  readonly status: PaletteSearch['status'];
  /** The Pages group, or with an empty field the recently updated pages. */
  readonly rows: readonly PaletteRow[];
  /** The People group, listed after the pages. */
  readonly people: readonly PaletteUser[];
  /** The highlighted row, counted down the pages and then the people. */
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

const noteFor = (status: PaletteSearch['status'], count: number, browsing: boolean): string | null => {
  if (status === 'idle') return 'Type to search';
  if (status === 'loading') return browsing ? 'Loading…' : 'Searching…';
  if (status === 'error') return 'Search failed. Try again.';
  if (count > 0) return null;
  return browsing ? 'Nothing here yet' : 'No matches';
};

/** A title with the part the query matched tinted. */
const renderTitle = (title: string, query: string): ReactNode =>
  matchParts(title, query).map((part, index) =>
    part.match ? (
      <span key={index} className={paletteMatchClass}>
        {part.text}
      </span>
    ) : (
      part.text
    ),
  );

/**
 * The ⌘K palette (IMG-10.2): a modal search over the drive, or every drive.
 * The field is a combobox over the results listbox, so the highlight moves
 * with the arrows while focus stays in the field; Enter opens the
 * highlighted result, Tab switches between the drive and every drive, and
 * Escape closes. Focus never leaves the field, so the palette needs no other
 * tab stop. With the field empty it lists the recently updated pages;
 * typing lists two groups, Pages and People. The highlighted row carries the
 * Enter hint.
 */
export function renderPalette(props: PaletteRenderProps): ReactNode {
  const { open, query, allDrives, driveName, status, rows, people, active, idPrefix, inputRef } = props;
  const { typeQuery, toggleAllDrives, move, pick, hover, close } = props;
  if (!open) return null;
  const listId = `${idPrefix}-results`;
  const optionId = (index: number) => `${idPrefix}-result-${index}`;
  const count = rows.length + people.length;
  // A shorter answer than the highlight reaches starts again at its top.
  const highlighted = count === 0 ? -1 : active < count ? active : 0;
  const browsing = query.trim() === '';
  const note = noteFor(status, count, browsing);

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
      event.preventDefault();
      toggleAllDrives();
    }
  };

  const optionProps = (index: number) => ({
    id: optionId(index),
    role: 'option',
    'aria-selected': index === highlighted,
    className: paletteRowClass(index === highlighted),
    onMouseMove: () => hover(index),
    onClick: () => pick(index),
  });

  const enterHint = (index: number) =>
    index === highlighted ? <kbd className={paletteKbdClass('accent')}>↵</kbd> : null;

  // A segment never takes focus: a press keeps it in the field, and Tab is the keyboard's way to switch.
  const scopeOption = (label: string, selected: boolean) => (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={-1}
      className={paletteScopeOptionClass(selected)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={selected ? undefined : toggleAllDrives}
    >
      {label}
    </button>
  );

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
          <Search size={18} strokeWidth={2} aria-hidden="true" className={paletteSearchIconClass} />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search pages"
            aria-autocomplete="list"
            aria-expanded={count > 0}
            aria-controls={listId}
            aria-activedescendant={highlighted >= 0 ? optionId(highlighted) : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder={`Search ${allDrives ? 'all workspaces' : driveName}…`}
            className={paletteInputClass}
            onChange={(event) => typeQuery(event.currentTarget.value)}
          />
          <div role="radiogroup" aria-label="Search in" aria-keyshortcuts="Tab" className={paletteScopeClass}>
            {scopeOption(driveName, !allDrives)}
            {scopeOption('All workspaces', allDrives)}
          </div>
        </div>
        <div id={listId} role="listbox" aria-label="Results" className={paletteListClass}>
          {rows.length > 0 ? (
            <div role="group" aria-label={browsing ? 'Recently updated' : 'Pages'} className={paletteGroupClass}>
              <div className={paletteGroupLabelClass} aria-hidden="true">
                {browsing ? 'Recently updated' : 'Pages'}
              </div>
              {rows.map((row, index) => (
                <div key={row.id} {...optionProps(index)}>
                  <span className={paletteTileClass(index === highlighted)}>
                    {row.imago ? <ImagoOrb size="glyph" /> : <Icon name={row.icon} />}
                  </span>
                  <span className={paletteTextClass}>
                    <span className={paletteTitleClass}>{renderTitle(row.title, query)}</span>
                    {row.driveName === null ? null : <span className={paletteDriveClass}>{row.driveName}</span>}
                  </span>
                  {enterHint(index)}
                </div>
              ))}
            </div>
          ) : null}
          {people.length > 0 ? (
            <div role="group" aria-label="People" className={paletteGroupClass}>
              <div className={paletteGroupLabelClass} aria-hidden="true">
                People
              </div>
              {people.map((person, offset) => {
                const index = rows.length + offset;
                return (
                  <div key={person.id} {...optionProps(index)}>
                    <span className={paletteTileClass(index === highlighted)}>
                      <Icon name="members" />
                    </span>
                    <span className={paletteTextClass}>
                      <span className={paletteTitleClass}>{renderTitle(person.name, query)}</span>
                    </span>
                    {enterHint(index)}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
        <p role="status" className={note === null ? 'sr-only' : paletteNoteClass}>
          {note ?? `${count} ${count === 1 ? 'result' : 'results'}`}
        </p>
        <div aria-hidden="true" className={paletteFooterClass}>
          <span className={paletteHintClass}>
            <kbd className={paletteKbdClass('key')}>↑</kbd>
            <kbd className={paletteKbdClass('key')}>↓</kbd>
            Navigate
          </span>
          <span className={paletteHintClass}>
            <kbd className={paletteKbdClass('key')}>↵</kbd>
            Open
          </span>
          <span className={paletteHintClass}>
            <kbd className={paletteKbdClass('key')}>Tab</kbd>
            Switch scope
          </span>
          <span className={paletteHintEndClass}>
            <kbd className={paletteKbdClass('key')}>esc</kbd>
            Close
          </span>
        </div>
      </div>
    </div>
  );
}
