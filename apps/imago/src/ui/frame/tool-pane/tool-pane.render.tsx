import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderPaneHeader } from '../pane/pane-header';
import { listBodyClass, listPaneClass } from '../list-pane/list-pane-class';
import { cn } from '../../cn';
import type { ListPane } from '../stage/stage';

/** What every drive tool's pane is given: its drive, and the head's Close sidebar. */
export type ToolPaneProps = {
  readonly driveId: string;
  readonly close: ReactNode;
  /** The head's scope switch, for a tool that reads this drive or every drive. */
  readonly scope?: ReactNode;
  /** Wide beside the chat alone, narrow beside the tool's open screen. */
  readonly variant?: Exclude<ListPane, 'closed'>;
};

/** The pane chrome a tool pane sits in: the 48px head with its title, actions and Close sidebar, then the body. */
export function renderToolPane({ title, label, actions, close, scope = null, variant = 'tree', children }: {
  readonly title: string;
  /** The tool's scope switch beside the title: this drive or All drives. */
  readonly scope?: ReactNode;
  readonly label?: string;
  readonly actions?: ReactNode;
  readonly close: ReactNode;
  readonly variant?: Exclude<ListPane, 'closed'>;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <section className={listPaneClass(variant)} aria-label={label ?? title}>
      {renderPaneHeader({ title, scope, actions: <>{actions}{close}</> })}
      <div className={listBodyClass}>{children}</div>
    </section>
  );
}

const screenRowClass = (current: boolean): string =>
  cn(
    'flex h-8 items-center rounded-md px-2 text-sm no-underline hover:no-underline',
    current ? 'bg-accent-soft font-medium text-accent-deep' : 'text-ink hover:bg-fill',
  );

/** A pane row that opens the tool's whole screen in the middle (All activity, Everything in trash). */
export function renderToolScreenRow({ href, label, selected }: { readonly href: string; readonly label: string; readonly selected: boolean }): ReactNode {
  return (
    <Link href={href} prefetch={true} className={screenRowClass(selected)} aria-current={selected ? 'page' : undefined}>
      {label}
    </Link>
  );
}
