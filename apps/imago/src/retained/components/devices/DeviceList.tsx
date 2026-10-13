'use client';

import { useDevices, type Device } from '@/retained/hooks/useDevices';
import { DeviceRow } from './DeviceRow';
import { RevokeDeviceDialog } from './RevokeDeviceDialog';
import { useState, useEffect } from 'react';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Alert, AlertDescription } from '@/retained/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { useSocket } from '@/retained/hooks/useSocket';
import { toast } from 'sonner';
import { useAuth } from '@/retained/hooks/useAuth';

export function DeviceList() {
  const { devices, isLoading, isError, refetch } = useDevices();
  const [deviceToRevoke, setDeviceToRevoke] = useState<Device | null>(null);
  const socket = useSocket();
  const { actions } = useAuth();

  // Listen for real-time device events
  useEffect(() => {
    if (!socket) return;

    const handleDeviceAdded = (data: { deviceName?: string; platform: string }) => {
      toast.info(`New device connected: ${data.deviceName || `Unknown ${data.platform}`}`);
      refetch();
    };

    const handleDeviceRevoked = (data: { isCurrent: boolean; deviceName?: string }) => {
      if (data.isCurrent) {
        // Current device was revoked - force logout
        toast.error('This device has been logged out');
        actions.logout();
      } else {
        toast.info(`Device access revoked: ${data.deviceName || 'Unknown device'}`);
        refetch();
      }
    };

    const handleDeviceWarning = (data: { deviceName?: string; reason: string }) => {
      toast.warning(`Security alert: ${data.reason} on ${data.deviceName || 'a device'}`);
      refetch();
    };

    socket.on('device:added', handleDeviceAdded);
    socket.on('device:revoked', handleDeviceRevoked);
    socket.on('device:warning', handleDeviceWarning);

    return () => {
      socket.off('device:added', handleDeviceAdded);
      socket.off('device:revoked', handleDeviceRevoked);
      socket.off('device:warning', handleDeviceWarning);
    };
  }, [socket, refetch, actions]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Failed to load devices. Please try refreshing the page.
        </AlertDescription>
      </Alert>
    );
  }

  if (!devices || devices.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p>No devices connected to your account.</p>
      </div>
    );
  }

  const handleRevokeSuccess = () => {
    refetch();
    setDeviceToRevoke(null);
  };

  return (
    <>
      {/* Device list (the profile page owns the section heading and intro) */}
      <div className="divide-y divide-border rounded-xl border border-border">
        {devices.map((device) => (
          <DeviceRow key={device.id} device={device} onRevoke={(device) => setDeviceToRevoke(device)} />
        ))}
      </div>

      {deviceToRevoke && (
        <RevokeDeviceDialog
          device={deviceToRevoke}
          open={!!deviceToRevoke}
          onOpenChange={(open) => !open && setDeviceToRevoke(null)}
          onSuccess={handleRevokeSuccess}
        />
      )}
    </>
  );
}
