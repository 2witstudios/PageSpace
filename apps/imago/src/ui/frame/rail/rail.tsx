'use client';

import type { ReactNode } from 'react';
import { dispatch, transactions } from '../../store/transactions';
import { isHideableSection, type PaneLayout, type Stage } from '../stage/stage';
import { useUnreadBadges } from '../../messages/use-messages/use-messages';
import { useNotificationCount } from './notification-count';
import { NotificationBell } from './notification-bell';
import {
  activeRailItem,
  activeRailPlace,
  messagesUnread,
  railDrive,
  railItems,
  secondaryItems,
  settingsItem,
} from './rail-items';
import { renderRail } from './rail.render';

export type RailProps = {
  readonly stage: Stage;
  readonly layout: PaneLayout;
  /** Where the spine links on the stages that name no drive (DMs, the account). */
  readonly homeDriveId: string | null;
  /** The drive switcher's tile, above Search. */
  readonly brand: ReactNode;
  /** The avatar menu, at the foot. */
  readonly footer: ReactNode;
};

/**
 * Binds the spine to the URL's stage, the store and apps/web's counts (unread messages and
 * notifications), which realtime keeps live on every stage. The shell mounts it once, so the
 * counts' requests survive every navigation.
 */
export function Rail({ stage, layout, homeDriveId, brand, footer }: RailProps) {
  const { badges } = useUnreadBadges();
  const notifications = useNotificationCount();
  const driveId = railDrive(stage, homeDriveId);
  const { section } = stage;

  return renderRail({
    items: railItems(driveId),
    tools: secondaryItems(driveId),
    settings: settingsItem(driveId),
    activeId: activeRailItem(stage),
    activeAt: activeRailPlace(stage),
    unread: { messages: messagesUnread(badges) },
    bell: <NotificationBell count={notifications} current={stage.section === 'notifications'} />,
    onSearch: () => dispatch(transactions.openPalette, undefined),
    onReopen:
      layout.listHidden && isHideableSection(section)
        ? () => dispatch(transactions.expandSection, section)
        : undefined,
    brand,
    footer,
  });
}
