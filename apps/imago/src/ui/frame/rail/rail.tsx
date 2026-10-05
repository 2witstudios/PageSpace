'use client';

import type { ReactNode } from 'react';
import { dispatch, transactions } from '../../store/transactions';
import { useDisclosure } from '../disclosure/use-disclosure';
import { isListSection, type PaneLayout, type Stage } from '../stage/stage';
import { useUnreadBadges } from '../../messages/use-messages/use-messages';
import {
  activeRailItem,
  activeRailPlace,
  messagesUnread,
  overflowItems,
  railDrive,
  railItems,
  settingsItem,
} from './rail-items';
import { renderRail } from './rail.render';

export type RailProps = {
  readonly stage: Stage;
  readonly layout: PaneLayout;
  /** Where the rail links on the stages that name no drive (DMs, the account). */
  readonly homeDriveId: string | null;
  /** The drive switcher, above the sections. */
  readonly brand: ReactNode;
  /** The avatar menu, below Settings. */
  readonly footer: ReactNode;
};

/**
 * Binds the rail to the URL's stage, the store and apps/web's badge counts,
 * which inbox events keep live on every stage, not only in Messages. The
 * shell mounts it once, so the overflow's open state and the badge request
 * survive every navigation.
 */
export function Rail({ stage, layout, homeDriveId, brand, footer }: RailProps) {
  const { badges } = useUnreadBadges();
  const more = useDisclosure();
  const driveId = railDrive(stage, homeDriveId);
  const { section } = stage;

  return renderRail({
    items: railItems(driveId),
    settings: settingsItem(driveId),
    activeId: activeRailItem(stage),
    activeAt: activeRailPlace(stage),
    unread: { messages: messagesUnread(badges) },
    onReopen:
      layout.listHidden && isListSection(section)
        ? () => dispatch(transactions.expandSection, section)
        : undefined,
    overflow: driveId === null ? null : overflowItems(driveId),
    moreOpen: more.open,
    onMoreToggle: more.setOpen,
    moreRef: more.ref,
    brand,
    footer,
  });
}
