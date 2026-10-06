import type { ReactNode } from 'react';
import { paneHeaderClass } from './pane-class';

export type PaneHeaderProps = {
  readonly title: ReactNode;
  /** Trailing controls, such as close. */
  readonly actions?: ReactNode;
  /** A control ahead of the title: the hidden list's hamburger. */
  readonly leading?: ReactNode;
};

/** The leading slot sits beside the title, so it never covers it. */
export function renderPaneHeader({ title, actions, leading }: PaneHeaderProps): ReactNode {
  return (
    <header className={paneHeaderClass}>
      {leading === undefined || leading === null ? null : (
        <span className="flex flex-none" data-leading="">
          {leading}
        </span>
      )}
      <div className="min-w-0 flex-1 truncate font-semibold">{title}</div>
      {actions}
    </header>
  );
}
