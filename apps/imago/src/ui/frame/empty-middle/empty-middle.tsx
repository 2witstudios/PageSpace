'use client';

import type { ReactNode } from 'react';
import { useImagoPageId } from '../../chat/use-chat-data/use-chat-data';
import { ageLabel, drivePageHref, useRecents } from '../../files/recents/recents';
import { dispatch, transactions } from '../../store/transactions';
import { renderEmptyMiddle } from './empty-middle.render';

export type EmptyMiddleProps = {
  readonly driveId: string | null;
  /** Show sidebar, when the pane is closed too. */
  readonly leading: ReactNode;
};

/** The empty middle, bound to the viewer's recents and the store's Ask Imago (IMC-1.7). */
export function EmptyMiddle({ driveId, leading }: EmptyMiddleProps) {
  const recents = useRecents(driveId, 3);
  const imagoPageId = useImagoPageId();
  const now = new Date();
  return renderEmptyMiddle({
    leading,
    recents: recents.map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      href: driveId === null ? '/' : drivePageHref(driveId, row.id),
      age: ageLabel(row.viewedAt, now),
      imago: row.id === imagoPageId,
    })),
    onAskImago: () => dispatch(transactions.openImago, undefined),
  });
}
