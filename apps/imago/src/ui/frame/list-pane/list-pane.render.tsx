import type { ReactNode } from 'react';
import type { ListPane } from '../stage/stage';
import { renderPaneHeader } from '../pane/pane-header';
import { listBodyClass, listPaneClass } from './list-pane-class';

export type ListPaneRenderProps = {
  /** `list` is the 300px stage-2 pane; `tree` the 260px one beside an object or a nav. */
  readonly variant: Exclude<ListPane, 'closed'>;
  readonly title: string;
  /** The section's own head actions (Files' New page), ahead of Close sidebar. */
  readonly actions?: ReactNode;
  /** Close sidebar: the left pane collapses, it never closes with × (SPEC v3.2). */
  readonly close: ReactNode;
  readonly children: ReactNode;
};

/** A section's left pane: its 48px head (title, actions, Close sidebar) and a scrolling body. */
export function renderListPane(props: ListPaneRenderProps): ReactNode {
  const { variant, title, actions = null, close, children } = props;
  return (
    <section className={listPaneClass(variant)} aria-label={title}>
      {renderPaneHeader({
        title,
        actions: (
          <span className="flex flex-none items-center gap-1">
            {actions}
            {close}
          </span>
        ),
      })}
      <div className={listBodyClass}>{children}</div>
    </section>
  );
}
