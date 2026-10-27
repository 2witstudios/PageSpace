'use client';

import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/retained/components/ui/popover';
import NotificationDropdown from '@/retained/components/notifications/notification-dropdown';
import { renderIcon } from '../../components/icon/icon.render';
import { spineTileClass } from '../rail-button/rail-button-class';
import { renderRailTooltip, renderSpineCount } from '../rail-button/rail-button.render';

export type NotificationBellProps = {
  /** Unread notifications: the badge, and the count in the name. */
  readonly count: number;
  /** The notifications page is open. */
  readonly current: boolean;
};

/**
 * The spine's bell (C-Shell-Notifications, IMC-9.13): the unread count on the tile, and a popover
 * anchored beside it with the notifications grouped Today / Yesterday / Older.
 */
export function NotificationBell({ count, current }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const name = count > 0 ? `Notifications, ${count} unread` : 'Notifications';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={spineTileClass('small', current)}
          aria-label={name}
          aria-current={current ? 'page' : undefined}
        >
          {renderIcon({ name: 'bell', size: 18 })}
          {renderSpineCount(count)}
          {renderRailTooltip('Notifications')}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={12}
        aria-label="Notifications"
        className="w-auto overflow-hidden p-0"
      >
        <NotificationDropdown onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
