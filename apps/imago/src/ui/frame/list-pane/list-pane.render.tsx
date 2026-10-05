import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ListPane } from '../stage/stage';
import { paneControlClass } from '../pane/pane-class';
import { renderPaneHeader } from '../pane/pane-header';
import { listBodyClass, listPaneClass } from './list-pane-class';

export type ListPaneRenderProps = {
  /** `list` is the wide stage-2 pane; `tree` the narrow one beside an object. */
  readonly variant: Exclude<ListPane, 'closed'>;
  readonly title: string;
  /** Where × goes from the stage-2 list: the stage it opened from. */
  readonly closeHref: string;
  /** Void action: hides the stage-3 tree so the object gets the room. */
  readonly onCollapse: () => void;
  readonly children: ReactNode;
};

/** lucide at stroke 1.5 / 16px (DEC-8); the control carries the name. */
const icon = { size: 16, strokeWidth: 1.5, 'aria-hidden': true } as const;

/**
 * A section's list slot. Closing the stage-2 list leaves the section, so it
 * is a link; closing the stage-3 tree keeps the object open, so it is view
 * state (a store transaction).
 */
export function renderListPane(props: ListPaneRenderProps): ReactNode {
  const { variant, title, closeHref, onCollapse, children } = props;
  const close =
    variant === 'list' ? (
      <Link href={closeHref} prefetch aria-label={`Close ${title}`} className={paneControlClass}>
        <X {...icon} />
      </Link>
    ) : (
      <button type="button" aria-label={`Hide ${title}`} className={paneControlClass} onClick={onCollapse}>
        <X {...icon} />
      </button>
    );
  return (
    <section className={listPaneClass(variant)} aria-label={title}>
      {renderPaneHeader({ title, actions: close })}
      <div className={listBodyClass}>{children}</div>
    </section>
  );
}

export type ListOpenerRenderProps = {
  readonly title: string;
  readonly onOpen: () => void;
};

/**
 * While a list is hidden, a borderless hamburger in the leading slot of the
 * middle section's header slides it back (myimago ADR 0029 decision 2).
 */
export function renderListOpener({ title, onOpen }: ListOpenerRenderProps): ReactNode {
  return (
    <button type="button" aria-label={`Show ${title}`} className={paneControlClass} onClick={onOpen}>
      <Menu {...icon} />
    </button>
  );
}
