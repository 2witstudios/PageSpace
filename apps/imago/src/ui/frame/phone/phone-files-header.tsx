'use client';

import { useState, type ReactNode } from 'react';
import DriveSwitcherDialog from '@/retained/components/layout/navbar/DriveSwitcherDialog';
import { useMyOrganizations } from '@/retained/hooks/useMyOrganizations';
import type { DriveSummary } from '../drives/drives';
import { dispatch, transactions } from '../../store/transactions';
import { useNotificationCount } from '../rail/notification-count';
import { renderPhoneFilesHeader } from './phone-files-header.render';

export type PhoneFilesHeaderProps = {
  readonly driveName: string | null;
  /** The open drive's mark, as the drive list carries it. */
  readonly mark?: Pick<DriveSummary, 'avatarUrl' | 'color' | 'orgId'>;
  /** The screen's name, over the drive: "Files". */
  readonly title: string;
  readonly newPage: ReactNode;
};

/**
 * The phone Files head bound to the palette, the unread count and apps/web's drive switcher
 * (mounted on first opening, like the spine's drive tile).
 */
export function PhoneFilesHeader({ driveName, mark, title, newPage }: PhoneFilesHeaderProps) {
  const unread = useNotificationCount();
  const { orgById } = useMyOrganizations();
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return renderPhoneFilesHeader({
    driveName,
    mark: mark && { avatarUrl: mark.avatarUrl, color: mark.color, orgAvatarUrl: orgById(mark.orgId)?.avatarUrl ?? null },
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
