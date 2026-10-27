'use client';

/**
 * Drive settings → Environments (GA wave 3, leaf 4). The page the
 * `no_server_ops` refusal points at: the ONE place in the product where what
 * PageSpace may ask a local machine to do is seen and changed — by the
 * machine's owner — and where Stop, Resume and Revoke live.
 *
 * Reachable by any drive member (not only owner/admin like the other
 * settings pages): a plain member who enrolled a machine must be able to
 * reach their own toggles. What each viewer may DO is decided per row in the
 * editor ([D-6]), never by this page.
 */

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, Shield } from 'lucide-react';
import { useDriveStore } from '@/hooks/useDrive';
import { EnvironmentsManager } from '@/components/settings/EnvironmentsManager';

export default function EnvironmentsSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const search = useSearchParams();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find((d) => d.id === driveId);
  const canAdminister = Boolean(drive?.isOwned || drive?.role === 'ADMIN');

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl">
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-4 w-64 mb-8" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!drive) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Shield className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold mb-2">Drive not found</h2>
          <p className="text-muted-foreground">You are not a member of this drive.</p>
          <Button variant="outline" className="mt-4" onClick={() => router.push('/dashboard')}>
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => router.push(`/dashboard/${driveId}/settings`)} className="mb-4">
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold mb-1">Environments</h1>
        <p className="text-muted-foreground">Where this drive&apos;s sessions run, and what PageSpace may ask a local machine to do.</p>
      </div>

      <EnvironmentsManager driveId={driveId} canAdminister={canAdminister} initialEnvId={search?.get('env') ?? null} />
    </div>
  );
}
