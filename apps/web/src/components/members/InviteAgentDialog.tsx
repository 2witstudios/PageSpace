'use client';

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/useToast';
import { post } from '@/lib/auth/auth-fetch';
import { usePageAgents } from '@/hooks/page-agents/usePageAgents';

interface InviteAgentDialogProps {
  driveId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** agentPageIds already members of this drive, excluded from the picker. */
  existingAgentPageIds: string[];
  onInvited: () => void;
}

/**
 * Invite an AI agent into a drive, mirroring the human invite flow. Lists
 * agents the inviter can access (across their drives); the granted role is
 * capped server-side at the inviter's own access to this drive.
 */
export function InviteAgentDialog({
  driveId,
  open,
  onOpenChange,
  existingAgentPageIds,
  onInvited,
}: InviteAgentDialogProps) {
  const { toast } = useToast();
  const { allAgents, isLoading } = usePageAgents();
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [role, setRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER');
  const [submitting, setSubmitting] = useState(false);

  const existing = useMemo(() => new Set(existingAgentPageIds), [existingAgentPageIds]);
  const candidates = useMemo(
    () => allAgents.filter((a) => !existing.has(a.id)),
    [allAgents, existing],
  );

  const handleSubmit = async () => {
    if (!selectedAgent) return;
    setSubmitting(true);
    try {
      await post(`/api/drives/${driveId}/agents`, { agentPageId: selectedAgent, role });
      toast({ title: 'Agent invited', description: 'The agent now has access to this drive.' });
      setSelectedAgent('');
      setRole('MEMBER');
      onOpenChange(false);
      onInvited();
    } catch (e) {
      toast({
        title: 'Error',
        description: e instanceof Error ? e.message : 'Failed to invite agent',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite an agent</DialogTitle>
          <DialogDescription>
            Give an AI agent access to this drive. It can be an agent from any drive you can access.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Agent</Label>
            <Select value={selectedAgent} onValueChange={setSelectedAgent} disabled={isLoading}>
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    isLoading
                      ? 'Loading agents…'
                      : candidates.length === 0
                      ? 'No agents available to invite'
                      : 'Select an agent…'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {(agent.title || 'Unnamed Agent') + ' — ' + agent.driveName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as 'MEMBER' | 'ADMIN')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MEMBER">Member</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              You can&apos;t grant a role higher than your own access to this drive.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!selectedAgent || submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Invite'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
