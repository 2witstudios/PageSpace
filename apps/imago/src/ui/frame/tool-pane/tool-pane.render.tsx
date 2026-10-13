import type { ReactNode } from 'react';
import { renderPaneHeader } from '../pane/pane-header';
import { listBodyClass, listPaneClass } from '../list-pane/list-pane-class';

/** What every drive tool's pane is given: its drive, and the head's Close sidebar. */
export type ToolPaneProps = {
  readonly driveId: string;
  readonly close: ReactNode;
};

/** The pane chrome a tool pane sits in: the 48px head with its title, actions and Close sidebar, then the body. */
export function renderToolPane({ title, label, actions, close, children }: {
  readonly title: string;
  readonly label?: string;
  readonly actions?: ReactNode;
  readonly close: ReactNode;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <section className={listPaneClass('tree')} aria-label={label ?? title}>
      {renderPaneHeader({ title, actions: <>{actions}{close}</> })}
      <div className={listBodyClass}>{children}</div>
    </section>
  );
}
