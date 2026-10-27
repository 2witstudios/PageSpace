import type { ReactNode } from 'react';
import { paneHeaderClass } from './pane-class';

export type PaneHeaderProps = {
  readonly title: ReactNode;
  /** Trailing controls, such as close. */
  readonly actions?: ReactNode;
  /** A control ahead of the title: the hidden list's hamburger. */
  readonly leading?: ReactNode;
  /** The section's scope switch, right after the title: this drive or All drives. */
  readonly scope?: ReactNode;
};

/** The leading slot sits beside the title, so it never covers it. */
export function renderPaneHeader({ title, actions, leading, scope }: PaneHeaderProps): ReactNode {
  return (
    <header className={paneHeaderClass}>
      {leading === undefined || leading === null ? null : (
        <span className="flex flex-none" data-leading="">
          {leading}
        </span>
      )}
      {scope === undefined || scope === null ? (
        <div className="min-w-0 flex-1 truncate font-semibold">{title}</div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <div className="min-w-0 truncate font-semibold">{title}</div>
          {scope}
        </div>
      )}
      {actions}
    </header>
  );
}
