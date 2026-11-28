'use client';

import { useUnreadBadges } from '../../messages/use-messages/use-messages';
import { AvatarMenu } from '../avatar-menu/avatar-menu';
import { messagesUnread } from '../rail/rail-items';
import { useNotificationCount } from '../rail/notification-count';
import type { Stage } from '../stage/stage';
import { phoneBarItems } from './phone-bar-model';
import { renderPhoneBar } from './phone-bar.render';

export type PhoneBottomBarProps = {
  readonly stage: Stage;
  /** The drive the bar links into: the URL's, or Home on the driveless stages. */
  readonly driveId: string | null;
};

/**
 * The phone bottom bar bound to the URL's stage and apps/web's unread counts. Phone screens
 * (the Files tree, the page, full-screen Imago) share it; it is the spine's replacement.
 */
export function PhoneBottomBar({ stage, driveId }: PhoneBottomBarProps) {
  const { badges } = useUnreadBadges();
  const notifications = useNotificationCount();
  return renderPhoneBar({
    items: phoneBarItems(stage, driveId, messagesUnread(badges)),
    more: <AvatarMenu active={stage.section === 'account'} more={{ notifications }} />,
  });
}
