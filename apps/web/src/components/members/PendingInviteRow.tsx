'use client';

import { Mail, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

export interface PendingInvite {
  id: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  invitedByName: string;
  createdAt: string;
  expiresAt: string | null;
}

interface PendingInviteRowProps {
  invite: PendingInvite;
  canRevoke?: boolean;
  onRevoke?: (inviteId: string) => void | Promise<void>;
}

export function PendingInviteRow({ invite, canRevoke = false, onRevoke }: PendingInviteRowProps) {
  const [isRevoking, setIsRevoking] = useState(false);

  const handleConfirmRevoke = async () => {
    if (!onRevoke) return;
    setIsRevoking(true);
    try {
      await onRevoke(invite.id);
    } finally {
      setIsRevoking(false);
    }
  };

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

  const isExpired = invite.expiresAt !== null && new Date(invite.expiresAt).getTime() < Date.now();

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

      {canRevoke && onRevoke && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
              title="Revoke Invitation"
              aria-label={`Revoke invitation for ${invite.email}`}
              disabled={isRevoking}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke this invitation?</AlertDialogTitle>
              <AlertDialogDescription>
                The invitation to <span className="font-medium">{invite.email}</span> will be deleted.
                The recipient&apos;s link will stop working immediately. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleConfirmRevoke}>Revoke</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
