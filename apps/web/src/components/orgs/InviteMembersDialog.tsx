'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useEditingStore } from '@/stores/useEditingStore';
import { inviteToOrg } from '@/lib/orgs/org-api';
import { parseInviteEmails } from '@/lib/orgs/create-org-flow';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';

const EDITING_ID = 'org-invite-members';

/** Invite people to the org by email (ORG-3); each invitation reserves a seat (SEAT-3). */
export function InviteMembersDialog({ orgId, orgName, open, onOpenChange, onInvited }: {
  orgId: string;
  orgName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: () => void;
}) {
  const [text, setText] = useState('');
  const [role, setRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER');
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    useEditingStore.getState().startEditing(EDITING_ID, 'form', { componentName: 'InviteMembersDialog' });
    return () => useEditingStore.getState().endEditing(EDITING_ID);
  }, [open]);

  const close = (next: boolean) => {
    if (!next) {
      setText('');
      setRole('MEMBER');
      setError(null);
      setFailures([]);
    }
    onOpenChange(next);
  };

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = parseInviteEmails(text);
    if (parsed.invalid.length > 0) return setError(`These are not email addresses: ${parsed.invalid.join(', ')}`);
    if (parsed.valid.length === 0) return setError('Add at least one email address.');
    setError(null);
    setSending(true);
    const failed: string[] = [];
    let sent = 0;
    for (const email of parsed.valid) {
      try {
        await inviteToOrg(orgId, { email, role });
        sent += 1;
      } catch (err) {
        failed.push(`${email}: ${orgErrorMessage(err, 'the invitation did not go through.')}`);
      }
    }
    setSending(false);
    if (sent > 0) {
      toast.success(`${sent} ${sent === 1 ? 'invitation' : 'invitations'} sent`);
      onInvited();
    }
    if (failed.length === 0) close(false);
    else setFailures(failed);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[560px]">
        <form onSubmit={send} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Invite people to {orgName}</DialogTitle>
            <DialogDescription>Each person you invite uses a seat as soon as the invitation is sent.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="org-invite-emails">Email addresses</Label>
            <Textarea id="org-invite-emails" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="sam@northwind.com, alex@northwind.com" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="org-invite-role">Org role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as 'MEMBER' | 'ADMIN')}>
              <SelectTrigger id="org-invite-role" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MEMBER">Member</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          {failures.length > 0 ? (
            <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-destructive">
              {failures.map((f) => <li key={f}>{f}</li>)}
            </ul>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)} disabled={sending}>Cancel</Button>
            <Button type="submit" disabled={sending}>
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Send invitations
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
