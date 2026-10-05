'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { dispatch, transactions } from '../../store/transactions';
import { isListSection, type PaneLayout, type Stage } from '../stage/stage';
import {
  SIDEBAR_BADGES,
  activeRailItem,
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
  readonly footer: ReactNode;
};

/**
 * Binds the rail to the URL's stage, the store and apps/web's badge counts.
 * The shell mounts it once, so the overflow's open state and the badge
 * request survive every navigation.
 */
export function Rail({ stage, layout, homeDriveId, footer }: RailProps) {
  const { data: badges } = useSWR<unknown>(SIDEBAR_BADGES);
  const [moreOpen, setMoreOpen] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  const driveId = railDrive(stage, homeDriveId);
  const { section } = stage;

  // Escape and a press anywhere outside the disclosure close the overflow,
  // as a menu would; the rail's other controls count as outside.
  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const disclosure = rail.current?.querySelector('details');
      if (!(event.target instanceof Node) || !disclosure?.contains(event.target)) setMoreOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [moreOpen]);

  return (
    // `contents` keeps the lists children of the rail's flex column.
    <div ref={rail} className="contents">
      {renderRail({
        items: railItems(driveId),
        settings: settingsItem(driveId),
        activeId: activeRailItem(stage),
        unread: { messages: messagesUnread(badges) },
        onReopen:
          layout.listHidden && isListSection(section)
            ? () => dispatch(transactions.expandSection, section)
            : undefined,
        overflow: driveId === null ? null : overflowItems(driveId),
        moreOpen,
        onMoreToggle: setMoreOpen,
        footer,
      })}
    </div>
  );
}
