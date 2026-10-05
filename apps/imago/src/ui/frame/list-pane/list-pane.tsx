'use client';

import type { ReactNode } from 'react';
import { dispatch, transactions } from '../../store/transactions';
import type { ListPane as ListPaneVariant, ListSection } from '../stage/stage';
import { renderListOpener, renderListPane } from './list-pane.render';

export type ListPaneProps = {
  readonly section: ListSection;
  readonly variant: Exclude<ListPaneVariant, 'closed'>;
  readonly title: string;
  readonly closeHref: string;
  /** The section's own header controls, ahead of the close. */
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
};

/** Binds the tree's × to the store: hiding is per section, never a route. */
export function ListPane({ section, variant, title, closeHref, actions = null, children = null }: ListPaneProps) {
  return renderListPane({
    variant,
    title,
    closeHref,
    actions,
    onCollapse: () => dispatch(transactions.collapseSection, section),
    children,
  });
}

export type ListOpenerProps = {
  readonly section: ListSection;
  readonly title: string;
};

export function ListOpener({ section, title }: ListOpenerProps) {
  return renderListOpener({ title, onOpen: () => dispatch(transactions.expandSection, section) });
}
