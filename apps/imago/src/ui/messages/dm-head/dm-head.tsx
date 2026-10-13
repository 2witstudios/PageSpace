import type { ReactNode } from 'react';
import Link from 'next/link';
import { crumbClass, crumbSeparatorClass, crumbsClass, pageHeadClass } from '../../files/page-head/page-head-class';

export type DmHeadProps = {
  /** The last crumb: the other person's name, or "New message". */
  readonly title: string;
  /** The conversation's options control; absent on the new-message head. */
  readonly options?: ReactNode;
  /** The shell's Show sidebar, while the pane is closed. */
  readonly leading?: ReactNode;
  /** The shell's controls at the end: the Ask pill and Close. */
  readonly trailing?: ReactNode;
};

/**
 * The DM page's 48px head (C-DM-Conversation, C-DM-New): "Direct messages › <title>" and the
 * conversation options. It has no Share: a DM is not a shared page.
 */
export function DmHead({ title, options, leading, trailing }: DmHeadProps): ReactNode {
  return (
    <header className={pageHeadClass}>
      {leading}
      <ol aria-label="Path" className={crumbsClass}>
        <li className="flex min-w-0 items-center gap-1">
          <Link href="/dm" className={`${crumbClass(false)} no-underline hover:text-ink`}>
            Direct messages
          </Link>
        </li>
        <li className="flex min-w-0 items-center gap-1">
          <span aria-hidden="true" className={crumbSeparatorClass}>
            ›
          </span>
          <span className={crumbClass(true)} aria-current="page">
            {title}
          </span>
        </li>
      </ol>
      {options === undefined ? null : <span className="flex flex-none items-center gap-1 pl-2">{options}</span>}
      {trailing}
    </header>
  );
}
