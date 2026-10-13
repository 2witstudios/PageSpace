import Link from 'next/link';
import { Fragment, type DragEvent, type ReactNode } from 'react';
import { renderButton } from '../../components/button/button.render';
import { pageTypeIcons } from '../../components/page-type-icon/page-type-icon';
import { Icon } from '../../components/icon/icon';
import type { IconName } from '../../components/icon/icon-names';
import { ToolbarStrip } from '../../frame/toolbar-strip/toolbar-strip';
import type { PageTypeValue } from '@pagespace/lib/client-safe';
import { ariaSortOf, type SortKey, type SortState } from './files-browser-sort';
import type { FilesView } from './files-browser-model';
import {
  alertClass,
  browserBodyClass,
  browserClass,
  browserContentClass,
  crumbClass,
  crumbSepClass,
  crumbsClass,
  dateCellClass,
  dropNoteClass,
  dropZoneClass,
  emptyActionsClass,
  emptyClass,
  emptyDetailClass,
  emptyTitleClass,
  headCellClass,
  hintClass,
  menuClass,
  menuItemClass,
  menuSeparatorClass,
  metaCellClass,
  moreButtonClass,
  nameCellClass,
  nameLinkClass,
  rowClass,
  sortButtonClass,
  tableClass,
  tileClass,
  tileTitleClass,
  tilesClass,
  viewButtonClass,
  viewGroupClass,
} from './files-browser-class';

export type Crumb = { readonly href: string; readonly label: string; readonly current: boolean };

/** A row or tile as the browser draws it. */
export type BrowserRow = {
  readonly id: string;
  readonly title: string;
  readonly pageType: PageTypeValue;
  readonly typeLabel: string;
  /** The day it last changed, as M/D/YYYY; null for a create still in flight. */
  readonly updated: string | null;
  readonly href: string;
  /** Drawn but not yet a page the server lists: no link. */
  readonly pending: boolean;
  readonly menuLabel: string;
  readonly menuOpen: boolean;
  /** Opens the row's menu at the hover button's corner. */
  readonly onOpenMenu: (x: number, y: number) => void;
  /** Opens the row's menu at the pointer (right-click). */
  readonly onContextMenu: (x: number, y: number) => void;
};

export type MenuEntry =
  | { readonly kind: 'separator'; readonly key: string }
  | {
      readonly kind: 'item';
      readonly key: string;
      readonly label: string;
      readonly icon?: IconName;
      readonly danger?: boolean;
      /** A link to the page (or folder) when set; otherwise an action button. */
      readonly href?: string;
      readonly newTab?: boolean;
      readonly onSelect: () => void;
    };

export type OpenMenu = {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly entries: readonly MenuEntry[];
};

export type FilesBrowserRenderProps = {
  readonly crumbs: readonly Crumb[];
  readonly view: FilesView;
  readonly onView: (view: FilesView) => void;
  readonly sort: SortState;
  readonly onSort: (key: SortKey) => void;
  readonly rows: readonly BrowserRow[];
  /** The folder's name, or the drive's when the browser shows the top. */
  readonly folderName: string;
  /** The folder holds nothing the browser can show. */
  readonly empty: boolean;
  /** Files being dragged over the browser; zero when none are. */
  readonly dropCount: number;
  readonly onNewPage: () => void;
  readonly onUpload: () => void;
  readonly onDragEnter: (event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
  /** The hidden file input the Upload files buttons open. */
  readonly picker: ReactNode;
  /** Why the last create failed, if it did. */
  readonly createError: string | null;
  /** What the last upload could not do, if anything. */
  readonly uploadNotice: string | null;
  readonly menu: OpenMenu | null;
  readonly onCloseMenu: () => void;
};

const COLUMNS: readonly { readonly key: SortKey; readonly label: string; readonly width: string }[] = [
  { key: 'title', label: 'Name', width: '' },
  { key: 'type', label: 'Type', width: 'w-32' },
  { key: 'updatedAt', label: 'Last Modified', width: 'w-40' },
];

const iconOf = (pageType: PageTypeValue): { readonly icon: IconName; readonly hue: string } => pageTypeIcons[pageType];

const pageIcon = (pageType: PageTypeValue, size: number): ReactNode => {
  const { icon, hue } = iconOf(pageType);
  return <Icon name={icon} size={size} className={`${hue} shrink-0`} />;
};

const menuEntry = (entry: MenuEntry): ReactNode => {
  if (entry.kind === 'separator') return <div key={entry.key} role="separator" className={menuSeparatorClass} />;
  const content = (
    <>
      {entry.icon ? <Icon name={entry.icon} size={15} className="text-ink-muted" /> : null}
      <span>{entry.label}</span>
    </>
  );
  if (entry.href !== undefined) {
    return (
      <Link
        key={entry.key}
        href={entry.href}
        prefetch={false}
        role="menuitem"
        target={entry.newTab ? '_blank' : undefined}
        rel={entry.newTab ? 'noopener noreferrer' : undefined}
        onClick={entry.onSelect}
        className={menuItemClass(entry.danger === true)}
      >
        {content}
      </Link>
    );
  }
  return (
    <button key={entry.key} type="button" role="menuitem" onClick={entry.onSelect} className={menuItemClass(entry.danger === true)}>
      {content}
    </button>
  );
};

const nameOf = (row: BrowserRow): ReactNode => (
  <>
    {pageIcon(row.pageType, 20)}
    <span data-name="" className="min-w-0 truncate">
      {row.title}
    </span>
    {row.pending ? <span className="text-xs font-normal text-ink-faint">Creating…</span> : null}
  </>
);

const listRow = (row: BrowserRow): ReactNode => (
  <tr
    key={row.id}
    className={rowClass(row.pending, row.menuOpen)}
    data-page-type={row.pageType}
    aria-busy={row.pending ? 'true' : undefined}
    onContextMenu={(event) => {
      event.preventDefault();
      row.onContextMenu(event.clientX, event.clientY);
    }}
  >
    <td className="h-10 w-10 pl-2">{pageIcon(row.pageType, 20)}</td>
    <td className={nameCellClass}>
      {row.pending ? (
        <span className={nameLinkClass}>{nameOf(row)}</span>
      ) : (
        <Link href={row.href} prefetch className={nameLinkClass}>
          {nameOf(row)}
        </Link>
      )}
    </td>
    <td className={metaCellClass} data-type="">
      {row.typeLabel}
    </td>
    <td className={dateCellClass} data-modified="">
      {row.updated ?? '—'}
    </td>
    <td className="w-10 pr-2 text-right">
      <button
        type="button"
        aria-label={row.menuLabel}
        aria-haspopup="menu"
        aria-expanded={row.menuOpen}
        data-menu-trigger=""
        className={moreButtonClass(row.menuOpen)}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          row.onOpenMenu(box.right, box.bottom);
        }}
      >
        <Icon name="more" size={15} />
      </button>
    </td>
  </tr>
);

const tile = (row: BrowserRow): ReactNode => (
  <Link
    key={row.id}
    href={row.href}
    prefetch
    title={row.title}
    data-page-type={row.pageType}
    className={tileClass(row.menuOpen)}
    onContextMenu={(event) => {
      event.preventDefault();
      row.onContextMenu(event.clientX, event.clientY);
    }}
  >
    {pageIcon(row.pageType, 48)}
    <span className={tileTitleClass}>{row.title}</span>
  </Link>
);

const listing = (props: FilesBrowserRenderProps): ReactNode => {
  const { sort, onSort, rows, view } = props;
  if (view === 'grid') return <div className={tilesClass}>{rows.map(tile)}</div>;
  return (
    <>
      <table className={tableClass} aria-label="Folder contents">
        <thead>
          <tr>
            <th scope="col" className="w-10" />
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                scope="col"
                aria-sort={ariaSortOf(sort, column.key)}
                className={`${headCellClass} ${column.width} text-xs font-medium text-ink-muted`}
              >
                <button type="button" onClick={() => onSort(column.key)} className={sortButtonClass}>
                  {column.label}
                  {sort.key === column.key ? (
                    <Icon
                      name="chevronDown"
                      size={11}
                      className={sort.dir === 'asc' ? 'rotate-180' : undefined}
                    />
                  ) : null}
                </button>
              </th>
            ))}
            <th scope="col" className="w-10">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>{rows.map(listRow)}</tbody>
      </table>
      <p className={hintClass}>Right-click a row (or use its “…”) for Open, Rename, Favorite, Move, Copy and Trash.</p>
    </>
  );
};

const emptyBox = (props: FilesBrowserRenderProps): ReactNode => (
  <div data-testid="files-empty-state" data-empty="" className={emptyClass(props.dropCount > 0)}>
    <Icon name="folder" size={48} className="mb-2 text-ink-faint" />
    <p className={emptyTitleClass}>No child pages</p>
    <p className={emptyDetailClass}>Upload files or create a page to get started</p>
    <div className={emptyActionsClass}>
      {renderButton({ variant: 'primary', onClick: props.onUpload, children: 'Upload files' })}
      {renderButton({ variant: 'secondary', onClick: props.onNewPage, children: 'Create page' })}
    </div>
    {props.dropCount > 0 ? (
      <p className={dropNoteClass}>{`Drop to upload ${props.dropCount} files into ${props.folderName}`}</p>
    ) : null}
  </div>
);

const menuOf = (menu: OpenMenu, onClose: () => void): ReactNode => (
  <div
    role="menu"
    aria-label={menu.label}
    data-menu=""
    className={menuClass}
    style={{ left: menu.x, top: menu.y }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') onClose();
    }}
  >
    {menu.entries.map(menuEntry)}
  </div>
);

/**
 * The folder browser (C-Files-Browser): the Files strip (breadcrumb, List and
 * Grid, New Page), then the folder's contents as a sortable table or tiles, or
 * the empty state, with the row menu floating at its pointer.
 */
export function renderFilesBrowser(props: FilesBrowserRenderProps): ReactNode {
  const { crumbs, view, onView, onNewPage, dropCount, empty, createError, uploadNotice, menu, onCloseMenu } = props;
  return (
    <section
      className={browserClass}
      aria-label="Files browser"
      onDragEnter={props.onDragEnter}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
    >
      <ToolbarStrip label="Files">
        <nav aria-label="Breadcrumb" className={crumbsClass}>
          {crumbs.map((crumb, index) => (
            <Fragment key={crumb.href}>
              {index > 0 ? (
                <span aria-hidden="true" className={crumbSepClass}>
                  ›
                </span>
              ) : null}
              <Link
                href={crumb.href}
                prefetch
                aria-current={crumb.current ? 'page' : undefined}
                className={crumbClass(crumb.current)}
              >
                {crumb.label}
              </Link>
            </Fragment>
          ))}
        </nav>
        <div role="group" aria-label="View" className={viewGroupClass}>
          <button
            type="button"
            aria-label="List view"
            aria-pressed={view === 'list'}
            onClick={() => onView('list')}
            className={viewButtonClass(view === 'list')}
          >
            <Icon name="menu" size={15} />
          </button>
          <button
            type="button"
            aria-label="Grid view"
            aria-pressed={view === 'grid'}
            onClick={() => onView('grid')}
            className={viewButtonClass(view === 'grid')}
          >
            <Icon name="grid" size={15} />
          </button>
        </div>
        {renderButton({
          variant: 'primary',
          onClick: onNewPage,
          children: (
            <>
              <Icon name="plus" size={13} />
              New Page
            </>
          ),
        })}
      </ToolbarStrip>
      <div className={browserBodyClass}>
        <div className={browserContentClass}>
          {props.picker}
          {createError === null ? null : (
            <p role="alert" className={alertClass}>
              {createError}
            </p>
          )}
          {uploadNotice === null ? null : (
            <p role="alert" className={alertClass}>
              {uploadNotice}
            </p>
          )}
          <div className={dropZoneClass(dropCount > 0 && !empty)}>
            {empty ? emptyBox(props) : listing(props)}
          </div>
        </div>
      </div>
      {menu === null ? null : menuOf(menu, onCloseMenu)}
    </section>
  );
}
