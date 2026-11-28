'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { leaveOrganization } from '@/lib/orgs/org-api';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';

/** Confirms, then leaves (POST /api/orgs/[orgId]/leave). The one org action a plain Member has (UI-11). */
export function LeaveOrgDialog({ orgId, orgName, open, onOpenChange, onLeft }: {
  orgId: string;
  orgName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLeft: () => void;
}) {
  const [leaving, setLeaving] = useState(false);

  const leave = async (event: React.MouseEvent) => {
    event.preventDefault();
    setLeaving(true);
    try {
      await leaveOrganization(orgId);
      toast.success(`You left ${orgName}`);
      onOpenChange(false);
      onLeft();
    } catch (error) {
      toast.error(orgErrorMessage(error, 'Could not leave the organization. Try again.'));
    } finally {
      setLeaving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave {orgName}?</AlertDialogTitle>
          <AlertDialogDescription>
            You lose access to its drives, except drives you were invited to directly, which then treat you as a guest.
            Drives you lead are handed to another member. An Owner or Admin can invite you back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={leaving}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={leave} disabled={leaving} className="bg-destructive text-white hover:bg-destructive/90">
            Leave
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
