'use client';

import { useUnreadBadges } from '../use-messages/use-messages';
import { renderMessagesGround } from './messages-ground.render';

/** The Messages ground's unread counts, live from the server's totals. */
export function MessagesGround() {
  const { badges } = useUnreadBadges();
  return renderMessagesGround({ badges });
}
