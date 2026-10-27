'use client';

import type { ReactNode } from 'react';
import { CloseSidebar } from '../controls/controls';
import type { HideableSection, ListPane as ListPaneVariant } from '../stage/stage';
import { renderListPane } from './list-pane.render';

export type ListPaneProps = {
  readonly section: HideableSection;
  readonly variant: Exclude<ListPaneVariant, 'closed'>;
  readonly title: string;
  /** The section's own head actions, ahead of Close sidebar. */
  readonly actions?: ReactNode;
  /** The section's scope switch beside the title. */
  readonly scope?: ReactNode;
  readonly children?: ReactNode;
};

/** Binds the pane's Close sidebar to the store: hiding is per section, never a route. */
export function ListPane({ section, variant, title, actions = null, scope = null, children = null }: ListPaneProps) {
  return renderListPane({ variant, title, actions, scope, close: <CloseSidebar section={section} />, children });
}
