'use client';

import { PendingInviteRow, type PendingInvite } from './PendingInviteRow';

interface PendingInvitesSectionProps {
  invites: PendingInvite[];
  currentUserRole: 'OWNER' | 'ADMIN' | 'MEMBER';
}

/**
 * Owner/Admin-only list of pending drive invites. Renders nothing for
 * regular members or when the array is empty — keeps the members page
 * uncluttered for viewers without the management surface.
 */
export function PendingInvitesSection({ invites, currentUserRole }: PendingInvitesSectionProps) {
  const canSee = currentUserRole === 'OWNER' || currentUserRole === 'ADMIN';
  if (!canSee || invites.length === 0) return null;

  return (
    <div className="mt-6 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Pending invitations ({invites.length})
        </h3>
      </div>
      <div className="divide-y divide-gray-200 dark:divide-gray-700">
        {invites.map((invite) => (
          <PendingInviteRow key={invite.id} invite={invite} />
        ))}
      </div>
    </div>
  );
}
