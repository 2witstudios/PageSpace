'use client';

import { Mail } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export interface PendingInvite {
  id: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
}

interface PendingInviteRowProps {
  invite: PendingInvite;
}

export function PendingInviteRow({ invite }: PendingInviteRowProps) {
  const roleBadge =
    invite.role === 'ADMIN'
      ? (
          <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
            Admin
          </Badge>
        )
      : invite.role === 'OWNER'
      ? (
          <Badge className="bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
            Owner
          </Badge>
        )
      : (
          <Badge className="bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300">
            Member
          </Badge>
        );

  const expiresAt = new Date(invite.expiresAt);
  const isExpired = expiresAt.getTime() < Date.now();

  return (
    <div
      className="p-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
      data-testid="pending-invite-row"
      data-invite-id={invite.id}
    >
      <div className="flex items-center space-x-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300">
          <Mail className="h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center space-x-2">
            <p className="font-medium">{invite.email}</p>
            {roleBadge}
            <Badge
              variant="outline"
              className={
                isExpired
                  ? 'border-red-500/50 bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                  : 'border-yellow-500/50 bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
              }
            >
              {isExpired ? 'Expired' : 'Pending'}
            </Badge>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Invited by {invite.invitedByName}
          </p>
        </div>
      </div>
    </div>
  );
}
