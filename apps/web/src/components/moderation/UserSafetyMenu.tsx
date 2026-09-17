'use client';

import { useState } from 'react';
import { MoreVertical, Flag, Ban } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { post } from '@/lib/auth/auth-fetch';

interface UserSafetyMenuProps {
  userId: string;
  displayName: string;
  /** The conversation the report is about, when there is one. */
  conversationId?: string;
  onBlocked?: () => void;
}

/**
 * Report and Block for another user (App Review Guideline 1.2). Reports go to
 * the support inbox; a block stops direct messages in both directions.
 */
export function UserSafetyMenu({ userId, displayName, conversationId, onBlocked }: UserSafetyMenuProps) {
  const [reportOpen, setReportOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const sendReport = async () => {
    setSubmitting(true);
    try {
      await post('/api/user-reports', { targetUserId: userId, ...(conversationId ? { conversationId } : {}), reason: reason.trim() });
      toast.success('Report sent. Thank you — we review every report.');
      setReportOpen(false);
      setReason('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send the report');
    } finally {
      setSubmitting(false);
    }
  };

  const confirmBlock = async () => {
    setSubmitting(true);
    try {
      await post(`/api/users/${encodeURIComponent(userId)}/block`);
      toast.success(`${displayName} is blocked`);
      setBlockOpen(false);
      onBlocked?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not block this user');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`More options for ${displayName}`}>
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setReportOpen(true)}>
            <Flag className="h-4 w-4 mr-2" />
            Report {displayName}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setBlockOpen(true)} className="text-destructive">
            <Ban className="h-4 w-4 mr-2" />
            Block {displayName}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report {displayName}</DialogTitle>
            <DialogDescription>
              Tell us about objectionable content or abusive behaviour. Reports go to the PageSpace team.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="report-reason">What happened?</Label>
            <Textarea
              id="report-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={2000}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReportOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={() => void sendReport()} disabled={submitting || reason.trim().length === 0}>
              Send report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={blockOpen} onOpenChange={setBlockOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Block {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Neither of you will be able to send the other direct messages. You can unblock them later from
              Connections.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void confirmBlock()} disabled={submitting}>
              Block
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
