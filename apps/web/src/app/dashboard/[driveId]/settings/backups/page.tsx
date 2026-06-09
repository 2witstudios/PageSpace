'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChevronLeft, Shield, Plus, Loader2, Lock } from 'lucide-react';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth, post, patch } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import useSWR from 'swr';
import { format, formatDistanceToNow } from 'date-fns';

const PAGE_SIZE = 10;

// ============================================================================
// Types
// ============================================================================

type BackupFrequency = 'daily' | 'weekly' | 'monthly';

type BackupSchedule = {
  available: boolean;
  enabled: boolean;
  frequency: BackupFrequency;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

type SerializedBackup = {
  id: string;
  label: string | null;
  source: string;
  status: string;
  failureReason?: string | null;
  createdAt: string;
  completedAt: string | null;
  failedAt: string | null;
};

type BackupListResponse = { backups: SerializedBackup[] };

type CreateBackupResult = {
  backupId: string;
  status: string;
  counts: { pages: number; permissions: number; members: number; roles: number; files: number };
};

// ============================================================================
// Fetchers
// ============================================================================

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'ready') return 'default';
  if (status === 'failed') return 'destructive';
  return 'secondary';
}

const fetcher = (url: string) =>
  fetchWithAuth(url).then((r) => {
    if (!r.ok) throw new Error('Failed to fetch backups');
    return r.json();
  });

const scheduleFetcher = (url: string) =>
  fetchWithAuth(url).then((r) => {
    if (!r.ok) throw new Error('Failed to fetch schedule');
    return r.json() as Promise<BackupSchedule>;
  });

// ============================================================================
// AutomaticBackups component
// ============================================================================

function AutomaticBackups({ driveId }: { driveId: string }) {
  const scheduleKey = `/api/drives/${driveId}/backups/schedule`;
  const { data, isLoading, error, mutate } = useSWR<BackupSchedule>(
    scheduleKey,
    scheduleFetcher,
    { revalidateOnFocus: false }
  );

  const handleToggle = async (enabled: boolean) => {
    try {
      await mutate(
        patch<BackupSchedule>(scheduleKey, {
          enabled,
          frequency: data?.frequency ?? 'daily',
          timezone: data?.timezone ?? 'UTC',
        }),
        { optimisticData: data ? { ...data, enabled } : undefined, rollbackOnError: true }
      );
    } catch {
      toast.error('Failed to update backup schedule');
    }
  };

  const handleFrequencyChange = async (frequency: BackupFrequency) => {
    try {
      await mutate(
        patch<BackupSchedule>(scheduleKey, {
          enabled: data?.enabled ?? true,
          frequency,
          timezone: data?.timezone ?? 'UTC',
        }),
        { optimisticData: data ? { ...data, frequency } : undefined, rollbackOnError: true }
      );
    } catch {
      toast.error('Failed to update backup frequency');
    }
  };

  if (isLoading) {
    return <Skeleton className="h-28 w-full" />;
  }

  if (error || !data) {
    return null;
  }

  const { available, enabled, frequency, nextRunAt, lastRunAt } = data;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <div className="flex items-center gap-2">
            {!available && <Lock className="h-4 w-4 text-muted-foreground" />}
            <CardTitle>Automatic Backups</CardTitle>
          </div>
          {!available && (
            <CardDescription className="mt-1">
              <Link href="/settings/plan" className="underline hover:text-foreground">
                Upgrade to enable
              </Link>{' '}
              daily, weekly, or monthly snapshots.
            </CardDescription>
          )}
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={!available}
        />
      </CardHeader>
      <CardContent className={!available ? 'opacity-50 pointer-events-none' : undefined}>
        {available && enabled && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Frequency</Label>
              <Select value={frequency} onValueChange={handleFrequencyChange}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {nextRunAt && (
              <p
                className="text-sm text-muted-foreground"
                title={format(new Date(nextRunAt), 'PPpp')}
              >
                Next backup {formatDistanceToNow(new Date(nextRunAt), { addSuffix: true })}
              </p>
            )}
            {lastRunAt && (
              <p
                className="text-sm text-muted-foreground"
                title={format(new Date(lastRunAt), 'PPpp')}
              >
                Last backup {formatDistanceToNow(new Date(lastRunAt), { addSuffix: true })}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Page
// ============================================================================

export default function DriveBackupsPage() {
  const params = useParams();
  const router = useRouter();
  const driveId = params.driveId as string;
  const drives = useDriveStore((state) => state.drives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  const [newLabel, setNewLabel] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [accumulatedBackups, setAccumulatedBackups] = useState<SerializedBackup[]>([]);
  const [offset, setOffset] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const drive = drives.find((d) => d.id === driveId);
  const canManage = drive?.isOwned || drive?.role === 'ADMIN';

  const swrKey = drive && canManage
    ? `/api/drives/${driveId}/backups?limit=${PAGE_SIZE}&offset=0`
    : null;
  const { data, isLoading: isLoadingBackups, error, mutate } = useSWR<BackupListResponse>(
    swrKey,
    fetcher,
    { revalidateOnFocus: false }
  );

  useEffect(() => {
    if (data) {
      setAccumulatedBackups(data.backups);
      setOffset(data.backups.length);
      setHasMore(data.backups.length === PAGE_SIZE);
    }
  }, [data]);

  const handleLoadMore = useCallback(async () => {
    if (isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const r = await fetchWithAuth(
        `/api/drives/${driveId}/backups?limit=${PAGE_SIZE}&offset=${offset}`
      );
      if (!r.ok) throw new Error('Failed to load more');
      const result = (await r.json()) as BackupListResponse;
      setAccumulatedBackups((prev) => [...prev, ...result.backups]);
      setOffset((prev) => prev + result.backups.length);
      setHasMore(result.backups.length === PAGE_SIZE);
    } catch {
      toast.error('Failed to load more backups');
    } finally {
      setIsLoadingMore(false);
    }
  }, [driveId, isLoadingMore, offset]);

  const handleCreateBackup = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const result = await post<CreateBackupResult>(`/api/drives/${driveId}/backups`, {
        source: 'manual',
        label: newLabel.trim() || undefined,
      });
      toast.success(`Backup created — ${result.counts.pages} pages snapshotted`);
      setNewLabel('');
      setShowCreateForm(false);
      setAccumulatedBackups([]);
      setOffset(0);
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create backup');
    } finally {
      setIsCreating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
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
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl space-y-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/dashboard/${driveId}/settings`)}
          className="mb-4"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold mb-1">Backups</h1>
        <p className="text-muted-foreground">
          Create and restore snapshots of this drive&apos;s pages, members, and roles.
        </p>
      </div>

      <AutomaticBackups driveId={driveId} />

      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle>Create Backup</CardTitle>
            <CardDescription>Snapshot the current state of this drive</CardDescription>
          </div>
          {!showCreateForm && (
            <Button size="sm" onClick={() => setShowCreateForm(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Backup
            </Button>
          )}
        </CardHeader>
        {showCreateForm && (
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="backup-label">
                Label{' '}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="backup-label"
                placeholder="e.g. Before Q2 restructure"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateBackup();
                  if (e.key === 'Escape') {
                    setShowCreateForm(false);
                    setNewLabel('');
                  }
                }}
                disabled={isCreating}
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleCreateBackup} disabled={isCreating}>
                {isCreating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Snapshot Now
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowCreateForm(false);
                  setNewLabel('');
                }}
                disabled={isCreating}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Backup History</CardTitle>
          <CardDescription>All backups for {drive.name}</CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="text-sm text-muted-foreground py-4">Failed to load backups.</p>
          ) : isLoadingBackups ? (
            <div className="flex items-center gap-2 text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading backups…</span>
            </div>
          ) : accumulatedBackups.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No backups yet. Create one above to protect this drive.
            </p>
          ) : (
            <div className="divide-y">
              {accumulatedBackups.map((backup) => (
                <div key={backup.id} className="flex items-start justify-between py-3 gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={statusVariant(backup.status)}>{backup.status}</Badge>
                      <Badge variant="outline">{backup.source}</Badge>
                      {backup.label && (
                        <span className="text-sm font-medium truncate">{backup.label}</span>
                      )}
                    </div>
                    {backup.failureReason && (
                      <p className="text-xs text-destructive">{backup.failureReason}</p>
                    )}
                    {backup.status === 'ready' && (
                      <a
                        href="/settings/backups"
                        className="text-xs text-primary hover:underline"
                      >
                        Restore from Settings
                      </a>
                    )}
                  </div>
                  <div
                    className="text-right text-sm text-muted-foreground shrink-0"
                    title={format(new Date(backup.createdAt), 'PPpp')}
                  >
                    {formatDistanceToNow(new Date(backup.createdAt), { addSuffix: true })}
                  </div>
                </div>
              ))}
              {hasMore && (
                <div className="flex justify-end pt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleLoadMore}
                    disabled={isLoadingMore}
                  >
                    {isLoadingMore && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                    Load more
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
