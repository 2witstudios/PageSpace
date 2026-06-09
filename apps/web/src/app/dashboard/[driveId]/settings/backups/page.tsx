'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, Shield, Plus, Loader2, Lock } from 'lucide-react';
import Link from 'next/link';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth, post, patch } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import useSWR from 'swr';
import { format, formatDistanceToNow } from 'date-fns';

const PAGE_SIZE = 10;

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

type BackupFrequency = 'daily' | 'weekly' | 'monthly';

type BackupSchedule = {
  available: boolean;
  enabled: boolean;
  frequency: BackupFrequency;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

const scheduleFetcher = (url: string) =>
  fetchWithAuth(url).then((r) => {
    if (!r.ok) throw new Error('Failed to fetch schedule');
    return r.json() as Promise<BackupSchedule>;
  });

function AutomaticBackups({ driveId }: { driveId: string }) {
  const { data, isLoading, error, mutate } = useSWR<BackupSchedule>(
    `/api/drives/${driveId}/backups/schedule`,
    scheduleFetcher,
    { revalidateOnFocus: false }
  );
  const [saving, setSaving] = useState(false);

  const handleToggle = async (enabled: boolean) => {
    if (!data) return;
    setSaving(true);
    try {
      const updated = await patch<BackupSchedule>(`/api/drives/${driveId}/backups/schedule`, {
        enabled,
        frequency: data.frequency,
        timezone: data.timezone,
      });
      mutate({ ...data, ...updated }, false);
      toast.success(enabled ? 'Automatic backups enabled' : 'Automatic backups disabled');
    } catch {
      toast.error('Failed to update backup schedule');
    } finally {
      setSaving(false);
    }
  };

  const handleFrequencyChange = async (frequency: BackupFrequency) => {
    if (!data) return;
    setSaving(true);
    try {
      const updated = await patch<BackupSchedule>(`/api/drives/${driveId}/backups/schedule`, {
        enabled: data.enabled,
        frequency,
        timezone: data.timezone,
      });
      mutate({ ...data, ...updated }, false);
    } catch {
      toast.error('Failed to update backup frequency');
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return <Skeleton className="h-28 w-full" />;
  }

  if (error) {
    return null;
  }

  const available = data?.available ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="flex items-center gap-2">
            Automatic Backups
            {!available && <Lock className="h-4 w-4 text-muted-foreground" />}
          </span>
        </CardTitle>
        <CardDescription>
          {available
            ? 'Automatically snapshot this drive on a recurring schedule.'
            : <>Automatic backups require a Pro plan.{' '}<Link href="/settings/plan" className="underline">Upgrade to enable</Link></>
          }
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className={available ? undefined : 'opacity-50 pointer-events-none'}>
          <div className="flex items-center justify-between mb-4">
            <Label htmlFor="schedule-toggle">Enable automatic backups</Label>
            <Switch
              id="schedule-toggle"
              checked={data?.enabled ?? false}
              onCheckedChange={handleToggle}
              disabled={saving || !available}
            />
          </div>
          {data?.enabled && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Label htmlFor="schedule-frequency" className="w-20 shrink-0">Frequency</Label>
                <Select
                  value={data.frequency}
                  onValueChange={(v) => handleFrequencyChange(v as BackupFrequency)}
                  disabled={saving}
                >
                  <SelectTrigger id="schedule-frequency" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {data.nextRunAt && (
                <p className="text-sm text-muted-foreground">
                  Next backup{' '}
                  <span title={format(new Date(data.nextRunAt), 'PPpp')}>
                    {formatDistanceToNow(new Date(data.nextRunAt), { addSuffix: true })}
                  </span>
                </p>
              )}
              {data.lastRunAt && (
                <p className="text-sm text-muted-foreground">
                  Last backup{' '}
                  <span title={format(new Date(data.lastRunAt), 'PPpp')}>
                    {formatDistanceToNow(new Date(data.lastRunAt), { addSuffix: true })}
                  </span>
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

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
