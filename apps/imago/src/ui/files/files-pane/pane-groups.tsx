'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { PageTypeValue } from '@pagespace/lib/utils/enums';
import { renderIcon } from '../../components/icon/icon.render';
import { pageTypeIcons } from '../../components/page-type-icon/page-type-icon';
import { cn } from '../../cn';

/** An 11px uppercase group label that folds its group (SPEC v3 Files pane). */
export const paneGroupLabelClass =
  'flex w-full cursor-pointer items-center gap-1 border-0 bg-transparent px-2 pt-3 pb-1 text-left text-2xs font-medium tracking-wide text-ink-muted uppercase';

/** A favorite or recent: a 30px row, type icon, title and its age. */
export const paneRowClass = (current: boolean, roomy = false): string =>
  cn(
    'flex items-center gap-2 rounded-md px-2 text-sm no-underline hover:no-underline',
    roomy ? 'h-phone-row' : 'h-pane-row',
    current ? 'bg-accent-soft font-medium text-accent-deep' : 'text-ink hover:bg-fill',
  );

export function PaneGroup({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col gap-px">
      <button type="button" className={paneGroupLabelClass} aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open ? children : null}
    </div>
  );
}

export type PaneRowProps = {
  readonly href: string;
  readonly title: string;
  readonly type: PageTypeValue;
  readonly current: boolean;
  /** The age beside a recent (now, 1h); none for a favorite. */
  readonly meta?: string;
  /** A phone row: 44px tall. */
  readonly roomy?: boolean;
  /** Imago's own page: drawn with the orb. Any other agent takes its page-type glyph. */
  readonly imago?: boolean;
};

export function PaneRow({ href, title, type, current, meta, roomy = false, imago = false }: PaneRowProps) {
  const look = pageTypeIcons[type];
  return (
    <Link href={href} prefetch={true} className={paneRowClass(current, roomy)} aria-current={current ? 'page' : undefined}>
      <span className={imago ? undefined : look.hue} aria-hidden="true">
        {renderIcon({ name: imago ? 'imago' : look.icon, size: 15 })}
      </span>
      <span className="min-w-0 flex-1 truncate">{type === 'CHANNEL' ? `#${title}` : title}</span>
      {meta === undefined ? null : <span className="text-xs text-ink-faint">{meta}</span>}
    </Link>
  );
}
