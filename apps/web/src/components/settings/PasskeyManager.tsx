'use client';

import { useState, useCallback, useEffect } from 'react';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import useSWR, { mutate } from 'swr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Fingerprint, Key, Trash2, Pencil, Shield, Loader2, AlertCircle } from 'lucide-react';
import { useCSRFToken } from '@/hooks/useCSRFToken';

interface Passkey {
  id: string;
  name: string | null;
  deviceType: string | null;
  backedUp: boolean | null;
  lastUsedAt: string | null;
  createdAt: string;
}

// Import fetchWithAuth for consistent auth handling across the app
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const fetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
};

export function PasskeyManager() {
  const { csrfToken } = useCSRFToken();
  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);
  const [deletePasskeyId, setDeletePasskeyId] = useState<string | null>(null);
  const [editPasskey, setEditPasskey] = useState<Passkey | null>(null);
  const [newName, setNewName] = useState('');
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [pendingPasskeyId, setPendingPasskeyId] = useState<string | null>(null);

  // Check browser support
  useEffect(() => {
    setIsSupported(browserSupportsWebAuthn());
  }, []);

  const { data, error, isLoading } = useSWR<{ passkeys: Passkey[] }>(
    '/api/auth/passkey',
    fetcher,
    { revalidateOnFocus: false }
  );

  const passkeys = data?.passkeys ?? [];

  const handleRegister = useCallback(async () => {
    if (!csrfToken) {
      toast.error('Please wait for security token to load');
      return;
    }

    setIsRegistering(true);

    try {
      // Get registration options
      const optionsRes = await fetchWithAuth('/api/auth/passkey/register/options', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!optionsRes.ok) {
        const error = await optionsRes.json();
        if (error.code === 'MAX_PASSKEYS_REACHED') {
          toast.error('Maximum number of passkeys reached');
        } else {
          toast.error(error.error || 'Failed to start registration');
        }
        return;
      }

      const { options } = await optionsRes.json();

      // Start WebAuthn ceremony
      const registrationResponse = await startRegistration({ optionsJSON: options });

      // Verify registration (without name first)
      const verifyRes = await fetchWithAuth('/api/auth/passkey/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response: registrationResponse,
          expectedChallenge: options.challenge,
        }),
      });

      if (!verifyRes.ok) {
        const error = await verifyRes.json();
        toast.error(error.error || 'Failed to register passkey');
        return;
      }

      const { passkeyId } = await verifyRes.json();

      // Refresh the passkeys list
      mutate('/api/auth/passkey');

      // Show name dialog
      setPendingPasskeyId(passkeyId);
      setNewName('');
      setShowNameDialog(true);

      toast.success('Passkey registered successfully');
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          toast.error('Registration was cancelled');
        } else if (err.name === 'InvalidStateError') {
          toast.error('This passkey is already registered');
        } else {
          toast.error(`Registration failed: ${err.message}`);
        }
      } else {
        toast.error('Registration failed');
      }
    } finally {
      setIsRegistering(false);
    }
  }, [csrfToken]);

  const handleDelete = useCallback(async () => {
    if (!deletePasskeyId || !csrfToken) return;

    try {
      const res = await fetchWithAuth(`/api/auth/passkey/${deletePasskeyId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const error = await res.json();
        toast.error(error.error || 'Failed to delete passkey');
        return;
      }

      mutate('/api/auth/passkey');
      toast.success('Passkey deleted');
    } catch {
      toast.error('Failed to delete passkey');
    } finally {
      setDeletePasskeyId(null);
    }
  }, [deletePasskeyId, csrfToken]);

  const handleRename = useCallback(async () => {
    const passkeyId = editPasskey?.id || pendingPasskeyId;
    if (!passkeyId || !csrfToken || !newName.trim()) return;

    try {
      const res = await fetchWithAuth(`/api/auth/passkey/${passkeyId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: newName.trim() }),
      });

      if (!res.ok) {
        const error = await res.json();
        toast.error(error.error || 'Failed to rename passkey');
        return;
      }

      mutate('/api/auth/passkey');
      toast.success('Passkey renamed');
    } catch {
      toast.error('Failed to rename passkey');
    } finally {
      setEditPasskey(null);
      setShowNameDialog(false);
      setPendingPasskeyId(null);
      setNewName('');
    }
  }, [editPasskey, pendingPasskeyId, csrfToken, newName]);

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const getDeviceIcon = (deviceType: string | null) => {
    if (deviceType === 'multiDevice') return Shield;
    return Fingerprint;
  };

  if (isSupported === false) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground bg-muted/50 rounded-lg">
        <AlertCircle className="h-4 w-4" />
        <span>Your browser doesn&apos;t support passkeys.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Description */}
      <p className="text-sm text-muted-foreground">
        Passkeys are a more secure and convenient way to sign in. Use your device&apos;s
        fingerprint, face recognition, or security key.
      </p>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-2 p-4 text-sm text-destructive bg-destructive/10 rounded-lg">
          <AlertCircle className="h-4 w-4" />
          <span>Failed to load passkeys</span>
        </div>
      )}

      {/* Passkey list */}
      {!isLoading && !error && (
        <div className="space-y-2">
          {passkeys.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No passkeys registered yet.
            </p>
          ) : (
            passkeys.map((passkey) => {
              const DeviceIcon = getDeviceIcon(passkey.deviceType);
              return (
                <div
                  key={passkey.id}
                  className="flex items-center justify-between p-3 border rounded-lg bg-card"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-full bg-muted">
                      <DeviceIcon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {passkey.name || 'Unnamed Passkey'}
                        </span>
                        {passkey.backedUp && (
                          <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 rounded">
                            Synced
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Created {formatDate(passkey.createdAt)}
                        {passkey.lastUsedAt && ` • Last used ${formatDate(passkey.lastUsedAt)}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Rename passkey"
                      onClick={() => {
                        setEditPasskey(passkey);
                        setNewName(passkey.name || '');
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete passkey"
                      onClick={() => setDeletePasskeyId(passkey.id)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Add passkey button */}
      <Button
        onClick={handleRegister}
        disabled={isRegistering || isSupported === null}
        className="w-full"
      >
        {isRegistering ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Registering...
          </>
        ) : (
          <>
            <Key className="mr-2 h-4 w-4" />
            Add Passkey
          </>
        )}
      </Button>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deletePasskeyId} onOpenChange={() => setDeletePasskeyId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Passkey</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this passkey? You won&apos;t be able to use it
              to sign in anymore.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit/Name dialog */}
      <Dialog
        open={!!editPasskey || showNameDialog}
        onOpenChange={(open) => {
          if (!open) {
            setEditPasskey(null);
            setShowNameDialog(false);
            setPendingPasskeyId(null);
            setNewName('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editPasskey ? 'Rename Passkey' : 'Name Your Passkey'}
            </DialogTitle>
            <DialogDescription>
              Give your passkey a friendly name to help you identify it later.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g., MacBook Pro, iPhone"
              maxLength={255}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditPasskey(null);
                setShowNameDialog(false);
                setPendingPasskeyId(null);
                setNewName('');
              }}
            >
              {showNameDialog && !editPasskey ? 'Skip' : 'Cancel'}
            </Button>
            <Button onClick={handleRename} disabled={!newName.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
