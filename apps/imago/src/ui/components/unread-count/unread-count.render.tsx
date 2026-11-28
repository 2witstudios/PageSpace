import type { ReactNode } from 'react';
import { cn } from '../../cn';
import { unreadCountClass } from './unread-count-class';

export type UnreadCountProps = {
  readonly count: number;
  /** Placement only, such as the rail's corner; the pill owns its look. */
  readonly className?: string;
};

/**
 * An unread count, drawn only when there is something unread. Hidden from
 * assistive technology; the control it sits on carries the count in its
 * name.
 */
export function renderUnreadCount({ count, className }: UnreadCountProps): ReactNode {
  if (!(count > 0)) return null;
  return (
    <span className={cn(unreadCountClass, className)} aria-hidden="true">
      {count}
    </span>
  );
}
