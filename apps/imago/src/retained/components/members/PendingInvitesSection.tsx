'use client';

import { PendingInviteRow, type PendingInvite } from './PendingInviteRow';

interface PendingInvitesSectionProps {
  invites: PendingInvite[];
  currentUserRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  onRevoke?: (inviteId: string) => void | Promise<void>;
}

/**
 * Owner/Admin-only pending drive invites (C-Members "Pending invites"): the heading with its
 * live count, then each invite, or a line saying there are none. Regular members see nothing.
 */
export function PendingInvitesSection({ invites, currentUserRole, onRevoke }: PendingInvitesSectionProps) {
  const canManage = currentUserRole === 'OWNER' || currentUserRole === 'ADMIN';
  if (!canManage) return null;

  return (
    <section id="pending" aria-label="Pending invites" className="space-y-3">
      <h2 className="text-base font-semibold flex items-baseline gap-2">
        Pending invites
        <span className="font-mono text-sm font-normal tabular-nums text-gray-500 dark:text-gray-400">{invites.length}</span>
      </h2>
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
        {invites.length === 0 ? (
          <div className="p-6 text-center text-gray-500 dark:text-gray-400 text-sm">No pending invites.</div>
        ) : (
          invites.map((invite) => (
            <PendingInviteRow
              key={invite.id}
              invite={invite}
              canRevoke={canManage}
              {...(onRevoke && { onRevoke })}
            />
          ))
        )}
      </div>
    </section>
  );
}
