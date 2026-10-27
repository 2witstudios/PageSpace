'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from '@/retained-adapters/navigation';
import { Button } from '@/retained/components/ui/button';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Shield } from 'lucide-react';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { DriveIntegrations } from '@/retained/components/settings/DriveIntegrations';
import { IntegrationAuditLog } from '@/retained/components/settings/IntegrationAuditLog';
import { SettingsScreen } from '@/ui/settings/settings-screen/settings-screen';

export default function IntegrationsSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find((d) => d.id === driveId);
  const canManage = drive?.isOwned || drive?.role === 'ADMIN';

  if (isLoading) {
    return (
      <SettingsScreen title="Integrations">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </SettingsScreen>
    );
  }

  if (!drive || !canManage) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Shield className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold mb-2">Access Denied</h2>
          <p className="text-muted-foreground">Only drive owners and admins can access settings.</p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => router.push(`/dashboard/${driveId}`)}
          >
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SettingsScreen
      title="Integrations"
      lede="External services connected to this drive. Each AI Chat picks which of a connection’s tools its agent can use."
    >
      <DriveIntegrations driveId={driveId} />
      <IntegrationAuditLog driveId={driveId} />
    </SettingsScreen>
  );
}
