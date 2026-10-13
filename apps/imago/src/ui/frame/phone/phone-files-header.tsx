'use client';

import { useState, type ReactNode } from 'react';
import DriveSwitcherDialog from '@/retained/components/layout/navbar/DriveSwitcherDialog';
import { dispatch, transactions } from '../../store/transactions';
import { useNotificationCount } from '../rail/notification-count';
import { renderPhoneFilesHeader } from './phone-files-header.render';

export type PhoneFilesHeaderProps = {
  readonly driveName: string | null;
  /** The screen's name, over the drive: "Files". */
  readonly title: string;
  readonly newPage: ReactNode;
};

/**
 * The phone Files head bound to the palette, the unread count and apps/web's drive switcher
 * (mounted on first opening, like the spine's drive tile).
 */
export function PhoneFilesHeader({ driveName, title, newPage }: PhoneFilesHeaderProps) {
  const unread = useNotificationCount();
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return renderPhoneFilesHeader({
    driveName,
    title,
    unread,
    notificationsHref: '/notifications',
    open,
    onSwitch: () => {
      setOpened(true);
      setOpen((was) => !was);
    },
    onSearch: () => dispatch(transactions.openPalette, undefined),
    newPage,
    switcher: opened ? <DriveSwitcherDialog open={open} onOpenChange={setOpen} /> : null,
  });
}
