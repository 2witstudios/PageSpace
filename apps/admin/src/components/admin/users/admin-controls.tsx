'use client';

import { useState } from 'react';
import { Ban, Download, LogOut, ShieldCheck, ShieldOff, Trash2, UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmActionDialog } from './confirm-action-dialog';
import {
  changeUserRole,
  downloadUserExport,
  eraseUserData,
  revokeAllSessions,
  suspendUser,
  unsuspendUser,
} from './actions';
import type { AdminUser } from './types';

interface AdminControlsProps {
  user: AdminUser;
  onActionComplete: () => void;
}

type DialogKind = 'suspend' | 'unsuspend' | 'force-logout' | 'promote' | 'demote' | 'erase' | null;

export function AdminControls({ user, onActionComplete }: AdminControlsProps) {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const openDialog = (kind: DialogKind) => {
    setDialogError(null);
    setDialog(kind);
  };

  const run = async (action: () => Promise<{ message?: string }>) => {
    setPending(true);
    setDialogError(null);
    try {
      const result = await action();
      setDialog(null);
      setStatus(result.message ?? 'Done');
      setStatusError(null);
      onActionComplete();
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setPending(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    setStatusError(null);
    try {
      await downloadUserExport(user.id);
      setStatus('GDPR export downloaded');
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const suspended = user.suspendedAt != null;
  const isAdmin = user.role === 'admin';

  return (
    <div>
      <h4 className="text-sm font-medium mb-3 flex items-center">
        <ShieldCheck className="h-4 w-4 mr-2" />
        Admin Controls
      </h4>

      {suspended && (
        <div className="mb-3 p-2 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-800 dark:text-red-200">
          <div className="flex items-center gap-1 font-medium">
            <Ban className="h-3 w-3" />
            <span>Suspended {new Date(user.suspendedAt as string).toLocaleString()}</span>
          </div>
          {user.suspendedReason && (
            <div className="mt-1 text-muted-foreground">Reason: {user.suspendedReason}</div>
          )}
        </div>
      )}

      {status && (
        <p className="mb-2 text-xs text-success" role="status">{status}</p>
      )}
      {statusError && (
        <p className="mb-2 text-xs text-destructive" role="alert">{statusError}</p>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {suspended ? (
          <Button size="sm" variant="outline" onClick={() => openDialog('unsuspend')} disabled={pending}>
            <UserCheck className="h-4 w-4 mr-2" />
            Unsuspend
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => openDialog('suspend')} disabled={pending}>
            <Ban className="h-4 w-4 mr-2" />
            Suspend
          </Button>
        )}

        <Button size="sm" variant="outline" onClick={() => openDialog('force-logout')} disabled={pending}>
          <LogOut className="h-4 w-4 mr-2" />
          Force logout
        </Button>

        {isAdmin ? (
          <Button size="sm" variant="outline" onClick={() => openDialog('demote')} disabled={pending}>
            <ShieldOff className="h-4 w-4 mr-2" />
            Remove admin
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => openDialog('promote')} disabled={pending}>
            <ShieldCheck className="h-4 w-4 mr-2" />
            Make admin
          </Button>
        )}

        <Button size="sm" variant="outline" onClick={() => void handleExport()} disabled={exporting}>
          <Download className="h-4 w-4 mr-2" />
          {exporting ? 'Exporting…' : 'Export data (GDPR)'}
        </Button>

        <Button
          size="sm"
          variant="destructive"
          onClick={() => openDialog('erase')}
          disabled={pending}
          className="sm:col-span-2"
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Erase user (GDPR)
        </Button>
      </div>

      <ConfirmActionDialog
        open={dialog === 'suspend'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Suspend this user?"
        description={
          <span>
            <strong>{user.email}</strong> will be blocked from signing in and every active session
            is revoked immediately.
          </span>
        }
        confirmLabel="Suspend user"
        reasonPlaceholder="Why is this account being suspended?"
        pending={pending}
        error={dialogError}
        onConfirm={({ reason }) => void run(() => suspendUser(user.id, reason))}
      />

      <ConfirmActionDialog
        open={dialog === 'unsuspend'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Lift the suspension?"
        description={<span><strong>{user.email}</strong> will be able to sign in again.</span>}
        confirmLabel="Unsuspend user"
        destructive={false}
        requireReason={false}
        pending={pending}
        error={dialogError}
        onConfirm={() => void run(() => unsuspendUser(user.id))}
      />

      <ConfirmActionDialog
        open={dialog === 'force-logout'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Force logout everywhere?"
        description={
          <span>
            Every active session for <strong>{user.email}</strong> (web, admin, devices) is revoked.
            The account stays active and they can sign back in.
          </span>
        }
        confirmLabel="Revoke all sessions"
        requireReason={false}
        pending={pending}
        error={dialogError}
        onConfirm={() => void run(() => revokeAllSessions(user.id))}
      />

      <ConfirmActionDialog
        open={dialog === 'promote'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Grant admin access?"
        description={
          <span>
            <strong>{user.email}</strong> gets full access to this admin console, including user
            data and billing controls.
          </span>
        }
        confirmLabel="Make admin"
        reasonPlaceholder="Why is this user being promoted?"
        pending={pending}
        error={dialogError}
        onConfirm={({ reason }) => void run(() => changeUserRole(user.id, 'admin', reason))}
      />

      <ConfirmActionDialog
        open={dialog === 'demote'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Remove admin access?"
        description={
          <span>
            <strong>{user.email}</strong> loses admin access immediately — any active admin
            sessions are invalidated. You cannot demote yourself.
          </span>
        }
        confirmLabel="Remove admin"
        reasonPlaceholder="Why is admin access being removed?"
        pending={pending}
        error={dialogError}
        onConfirm={({ reason }) => void run(() => changeUserRole(user.id, 'user', reason))}
      />

      <ConfirmActionDialog
        open={dialog === 'erase'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Erase this user (GDPR)?"
        description={
          <span>
            This permanently deletes and anonymizes all data for <strong>{user.email}</strong>{' '}
            (GDPR Article 17). This cannot be undone. Consider downloading the GDPR export first.
          </span>
        }
        confirmLabel="Erase user permanently"
        typedConfirmation={{
          expected: user.email,
          label: `Type the user's email (${user.email}) to confirm`,
        }}
        reasonPlaceholder="Erasure request reference / justification"
        pending={pending}
        error={dialogError}
        onConfirm={({ reason }) => void run(() => eraseUserData(user.id, reason))}
      />
    </div>
  );
}
