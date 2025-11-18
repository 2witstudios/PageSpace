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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { toast } from 'sonner';

interface RevokeAllDevicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  deviceCount: number;
}

export function RevokeAllDevicesDialog({
  open,
  onOpenChange,
  onSuccess,
  deviceCount,
}: RevokeAllDevicesDialogProps) {
  const [password, setPassword] = useState('');
  const [isRevoking, setIsRevoking] = useState(false);

  const handleClose = () => {
    if (!isRevoking) {
      setPassword('');
      onOpenChange(false);
    }
  };

  const handleRevokeAll = async () => {
    if (!password.trim()) {
      toast.error('Please enter your password');
      return;
    }

    setIsRevoking(true);

    try {
      const response = await fetchWithAuth('/api/account/devices', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to revoke devices');
      }

      const data = await response.json();

      // Update device token if a new one was returned (due to rotation)
      if (data.deviceToken && typeof localStorage !== 'undefined') {
        localStorage.setItem('deviceToken', data.deviceToken);
      }

      toast.success('All other devices have been logged out');
      setPassword('');
      onSuccess();
    } catch (error) {
      console.error('Failed to revoke all devices:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to revoke devices');
    } finally {
      setIsRevoking(false);
    }
  };

  const otherDevicesCount = Math.max(0, deviceCount - 1);

  return (
    <AlertDialog open={open} onOpenChange={handleClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke All Other Devices?</AlertDialogTitle>
          <AlertDialogDescription>
            This will log out all other devices except the one you&apos;re currently using.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              <p className="font-semibold mb-2">Warning:</p>
              <ul className="list-disc list-inside text-sm space-y-1 ml-2">
                <li>
                  {otherDevicesCount} other {otherDevicesCount === 1 ? 'device' : 'devices'} will be
                  immediately logged out
                </li>
                <li>Those devices will need to sign in again</li>
                <li>All active sessions on other devices will be terminated</li>
              </ul>
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label htmlFor="password">Enter your password to confirm:</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && password.trim()) {
                  handleRevokeAll();
                }
              }}
              placeholder="Your password"
              disabled={isRevoking}
              autoComplete="current-password"
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isRevoking} onClick={handleClose}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleRevokeAll}
            disabled={isRevoking || !password.trim()}
            className="bg-destructive hover:bg-destructive/90"
          >
            {isRevoking ? 'Revoking...' : 'Revoke All Other Devices'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
