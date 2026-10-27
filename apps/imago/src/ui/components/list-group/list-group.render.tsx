import type { ReactNode } from 'react';
import { listGroupLabelClass, listGroupRowsClass } from './list-group-class';

export type ListGroupRenderProps = {
  /** Sentence case, as PageSpace labels its sidebar groups. */
  readonly label: string;
  /** The group's `<li>` rows. */
  readonly children: ReactNode;
};

/** A labelled run of sidebar rows: "Today", "Channels", "Direct messages". */
export function renderListGroup({ label, children }: ListGroupRenderProps): ReactNode {
  return (
    <section aria-label={label}>
      <h2 className={listGroupLabelClass}>{label}</h2>
      <ul className={listGroupRowsClass}>{children}</ul>
    </section>
  );
}
