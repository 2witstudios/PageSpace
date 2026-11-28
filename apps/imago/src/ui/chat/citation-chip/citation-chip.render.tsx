import Link from 'next/link';
import type { ReactNode } from 'react';
import { citationChipClass } from './citation-chip-class';

export type CitationChipRenderProps = {
  readonly label: ReactNode;
  /** The cited page in its drive's files section; null when no drive is known. */
  readonly href: string | null;
};

/**
 * A page the assistant cited. It opens the page in the object pane, inside
 * the same shell, so it is a client navigation and never a new tab.
 */
export function renderCitationChip({ label, href }: CitationChipRenderProps): ReactNode {
  return href === null ? (
    <span className={citationChipClass} data-citation="">
      {label}
    </span>
  ) : (
    <Link href={href} className={citationChipClass} data-citation="">
      {label}
    </Link>
  );
}
