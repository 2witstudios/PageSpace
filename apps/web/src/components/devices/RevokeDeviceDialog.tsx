'use client';

import { useState } from 'react';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';
import type { Device } from '@/hooks/useDevices';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';

interface RevokeDeviceDialogProps {
  device: Device;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function RevokeDeviceDialog({
  device,
  open,
  onOpenChange,
  onSuccess,
}: RevokeDeviceDialogProps) {
  const [isRevoking, setIsRevoking] = useState(false);
  const { actions } = useAuth();

  const handleClose = () => {
    if (!isRevoking) {
      onOpenChange(false);
    }
  };

  const handleRevoke = async () => {
    setIsRevoking(true);

    try {
      const response = await fetchWithAuth(`/api/account/devices/${device.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to revoke device');
      }

      const result = await response.json();

      if (result.requiresLogout) {
        // This device was revoked - force logout
        toast.success('This device has been logged out');
        await actions.logout();
        return;
      }

      toast.success('Device access revoked successfully');
      onSuccess();
    } catch (error) {
      console.error('Failed to revoke device:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to revoke device');
    } finally {
      setIsRevoking(false);
    }
  };

  const deviceName = device.deviceName || `Unknown ${device.platform}`;

  return (
    <AlertDialog open={open} onOpenChange={handleClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke Device Access?</AlertDialogTitle>
          <AlertDialogDescription>
            This device will be immediately logged out and will need to sign in again.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          {device.isCurrent && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <p className="font-semibold mb-1">Warning: This is your current device</p>
                <p className="text-sm">
                  Revoking this device will log you out immediately. You&apos;ll need to sign in again.
                </p>
              </AlertDescription>
            </Alert>
          )}

          <div className="rounded-md bg-muted p-3">
            <p className="text-sm font-medium">Device: {deviceName}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Last used: {new Date(device.lastUsedAt).toLocaleString()}
            </p>
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isRevoking} onClick={handleClose}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleRevoke}
            disabled={isRevoking}
            className="bg-destructive hover:bg-destructive/90"
          >
            {isRevoking ? 'Revoking...' : 'Revoke Access'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
