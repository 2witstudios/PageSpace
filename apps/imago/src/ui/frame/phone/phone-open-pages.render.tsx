import Link from 'next/link';
import type { ReactNode } from 'react';
import type { IconName } from '../../components/icon/icon-names';
import { renderIcon } from '../../components/icon/icon.render';
import { renderPageIcon } from '../../metal/page-icon';
import {
  phoneSheetClass,
  phoneSheetCloseAllClass,
  phoneSheetEmptyClass,
  phoneSheetGripClass,
  phoneSheetHeadClass,
  phoneSheetLinkClass,
  phoneSheetRowClass,
  phoneSheetRowCloseClass,
  phoneSheetScrimClass,
  phoneSheetTitleClass,
} from './phone-doc-class';

export const EMPTY_OPEN_PAGES = 'No open pages — pick one in Pages or ask Imago.';

export type OpenPageRowProps = {
  readonly path: string;
  readonly title: string;
  readonly icon: IconName;
  /** The type hue class (text-type-*), or none for screens. */
  readonly hue: string | null;
  /** Imago's own page: its orb in place of the type icon. */
  readonly imago?: boolean;
  readonly current: boolean;
  /** The row's link was followed: make its tab the active one. */
  readonly onOpen: () => void;
  readonly onClose: () => void;
};

/** One row: the type icon and title as a link, then its close control (36px). */
export function renderOpenPageRow({ path, title, icon, hue, imago, current, onOpen, onClose }: OpenPageRowProps): ReactNode {
  return (
    <div key={path} className={phoneSheetRowClass(current)} data-tab-path={path}>
      <Link href={path} prefetch={true} className={phoneSheetLinkClass} onClick={(event) => !event.defaultPrevented && onOpen()}>
        <span className={hue ?? 'text-ink-muted'} aria-hidden="true">
          {renderPageIcon({ icon, size: 18, imago })}
        </span>
        <span className="min-w-0 truncate">{title}</span>
      </Link>
      <button type="button" className={phoneSheetRowCloseClass} aria-label={`Close ${title}`} onClick={onClose}>
        {renderIcon({ name: 'close', size: 12 })}
      </button>
    </div>
  );
}

export type OpenPagesSheetProps = {
  /** The rows, from renderOpenPageRow; none shows the empty line. */
  readonly rows: readonly ReactNode[];
  /** Void action: the scrim was pressed. */
  readonly onDismiss: () => void;
  /** Void action: Close all. */
  readonly onCloseAll: () => void;
};

/**
 * The phone's open pages (C-Resp-Phone-Doc): the tab strip as a bottom sheet over a scrim, with
 * Close all and a row per tab. It draws against the phone frame, which is the positioned ancestor.
 */
export function renderOpenPagesSheet({ rows, onDismiss, onCloseAll }: OpenPagesSheetProps): ReactNode {
  return (
    <>
      <button type="button" className={phoneSheetScrimClass} aria-label="Close open pages" onClick={onDismiss} />
      <section role="dialog" aria-label="Open pages" className={phoneSheetClass}>
        <span aria-hidden="true" className={phoneSheetGripClass} />
        <div className={phoneSheetHeadClass}>
          <span className={phoneSheetTitleClass}>Open pages</span>
          <button type="button" className={phoneSheetCloseAllClass} onClick={onCloseAll}>
            Close all
          </button>
        </div>
        {rows}
        {rows.length === 0 ? <p className={phoneSheetEmptyClass}>{EMPTY_OPEN_PAGES}</p> : null}
      </section>
    </>
  );
}
