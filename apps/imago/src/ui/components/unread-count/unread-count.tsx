import { renderUnreadCount, type UnreadCountProps } from './unread-count.render';

export function UnreadCount(props: UnreadCountProps) {
  return renderUnreadCount(props);
}

export type { UnreadCountProps } from './unread-count.render';
