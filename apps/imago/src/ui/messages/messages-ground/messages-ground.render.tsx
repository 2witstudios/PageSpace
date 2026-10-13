import type { ReactNode } from 'react';
import type { SidebarBadges } from '../message-model/message';

/** The Messages ground's unread totals, read from /api/sidebar/badges. */
export type MessagesGroundRenderProps = {
  /** undefined while the totals load. */
  readonly badges: SidebarBadges | undefined;
};

const stats = (badges: SidebarBadges): readonly { readonly label: string; readonly value: number }[] => [
  { label: 'Unread in channels', value: badges.channels },
  { label: 'Unread direct messages', value: badges.dms },
];

/**
 * The strip of counts Imago's ground shows above the Messages conversation: unread in channels and
 * unread direct messages. "Threads you follow" is not drawn: no apps/web route counts it yet.
 */
export function renderMessagesGround({ badges }: MessagesGroundRenderProps): ReactNode {
  if (badges === undefined) return null;
  return (
    <div className="flex flex-wrap gap-3" aria-label="Unread">
      {stats(badges).map(({ label, value }) => (
        <div key={label} className="min-w-0 flex-1 rounded-xl border border-hairline px-4 py-3">
          <div className="text-xs text-ink-muted">{label}</div>
          <div className="font-mono text-2xl font-semibold tabular-nums text-ink">{value}</div>
        </div>
      ))}
    </div>
  );
}
