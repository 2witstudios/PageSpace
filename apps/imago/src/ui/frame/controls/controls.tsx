'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import { dispatch, transactions } from '../../store/transactions';
import type { HideableSection } from '../stage/stage';
import { askPillClass, headControlClass, headDividerClass } from './controls-class';

/**
 * The three kinds of column control (SPEC v3.2), never mixed: the left pane collapses
 * (left-panel icon), every middle area closes (×), and Imago docked collapses to the right
 * (right-panel icon), leaving the Ask pill.
 */

/** At the end of a left pane's head. */
export function CloseSidebar({ section }: { readonly section: HideableSection }): ReactNode {
  return (
    <button type="button" className={headControlClass} aria-label="Close sidebar" title="Close sidebar" onClick={() => dispatch(transactions.collapseSection, section)}>
      {renderIcon({ name: 'panelLeftClose', size: 16 })}
    </button>
  );
}

/** At the start of the first visible head while the pane is closed. */
export function ShowSidebar({ section }: { readonly section: HideableSection }): ReactNode {
  return (
    <button type="button" className={`${headControlClass} -ml-2`} aria-label="Show sidebar" title="Show sidebar" onClick={() => dispatch(transactions.expandSection, section)}>
      {renderIcon({ name: 'panelLeftOpen', size: 16 })}
    </button>
  );
}

/** At the end of Imago's head while it is docked beside a page. */
export function CollapseImago(): ReactNode {
  return (
    <button type="button" className={headControlClass} aria-label="Collapse Imago" title="Collapse Imago" onClick={() => dispatch(transactions.collapseImago, undefined)}>
      {renderIcon({ name: 'panelRightClose', size: 16 })}
    </button>
  );
}

/** At the end of Imago's head while it fills the middle. */
export function CloseImago(): ReactNode {
  return (
    <button type="button" className={headControlClass} aria-label="Close Imago" title="Close Imago" onClick={() => dispatch(transactions.closeImago, undefined)}>
      {renderIcon({ name: 'close', size: 12 })}
    </button>
  );
}

/** In the page head while Imago is collapsed: brings it back docked. */
export function AskPill(): ReactNode {
  return (
    <button type="button" className={askPillClass} onClick={() => dispatch(transactions.expandImago, undefined)}>
      {renderIcon({ name: 'sparkle', size: 12 })}
      Ask
    </button>
  );
}

/**
 * At the end of the page head: the page leaves the middle for its section, keeping its tab,
 * and Imago takes the middle: closing the page reopens Imago whether it was collapsed beside
 * the page or closed on an earlier ground, so the middle is never left empty by this.
 */
export function ClosePage({ href }: { readonly href: string }): ReactNode {
  return (
    <>
      <span className={headDividerClass} aria-hidden="true" />
      <Link href={href} prefetch={true} className={headControlClass} aria-label="Close page" title="Close page" onClick={() => dispatch(transactions.openImago, undefined)}>
        {renderIcon({ name: 'close', size: 12 })}
      </Link>
    </>
  );
}
