'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';
import { useDriveStore } from '@/hooks/useDrive';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { ArrowLeft, Download, HardDrive, Loader2, Plus } from 'lucide-react';
import useSWR from 'swr';
import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import { format, formatDistanceToNow } from 'date-fns';
import type { DriveBackupWithDriveName } from '@/services/api/drive-backup-service';
import { getExportFilename, getDownloadButtonLabel } from './utils';

const PAGE_SIZE = 50;

type SerializedBackup = Omit<DriveBackupWithDriveName, 'createdAt' | 'completedAt' | 'failedAt'> & {
  createdAt: string;
  completedAt: string | null;
  failedAt: string | null;
};

type BackupListResponse = { backups: SerializedBackup[]; total: number };

type CreateBackupResult = {
  backupId: string;
  status: string;
  counts: { pages: number; permissions: number; members: number; roles: number; files: number };
};

const fetcher = async (url: string): Promise<BackupListResponse> => {
  const r = await fetchWithAuth(url);
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const err = Object.assign(new Error((data as { error?: string }).error ?? 'Failed to fetch'), {
      status: r.status,
    });
    throw err;
  }
  return r.json();
};

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'ready') return 'default';
  if (status === 'failed') return 'destructive';
  return 'secondary';
}

export default function BackupsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const drives = useDriveStore((s) => s.drives);
  const currentDriveId = useDriveStore((s) => s.currentDriveId);
  const fetchDrives = useDriveStore((s) => s.fetchDrives);
  const isLoadingDrives = useDriveStore((s) => s.isLoading);

  const adminDrives = useMemo(
    () => drives.filter((d) => !d.isTrashed && (d.isOwned || d.role === 'OWNER' || d.role === 'ADMIN')),
    [drives]
  );

  const [createDriveId, setCreateDriveId] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [accumulatedBackups, setAccumulatedBackups] = useState<SerializedBackup[]>([]);
  const [offset, setOffset] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/auth/signin');
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  useEffect(() => {
    if (!createDriveId && adminDrives.length > 0) {
      const preferred =
        adminDrives.find((d) => d.id === currentDriveId) ?? adminDrives[0];
      setCreateDriveId(preferred.id);
    }
  }, [adminDrives, currentDriveId, createDriveId]);

  const swrKey = user ? `/api/backups?limit=${PAGE_SIZE}&offset=0` : null;
  const { data, isLoading: isLoadingBackups, mutate, error } = useSWR<BackupListResponse>(
    swrKey,
    fetcher,
    { revalidateOnFocus: false }
  );

  useEffect(() => {
    if (data) {
      setAccumulatedBackups(data.backups);
      setOffset(data.backups.length);
    }
  }, [data]);

  const handleLoadMore = useCallback(async () => {
    if (isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const r = await fetchWithAuth(`/api/backups?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!r.ok) throw new Error('Failed to load more backups');
      const result = (await r.json()) as BackupListResponse;
      setAccumulatedBackups((prev) => [...prev, ...result.backups]);
      setOffset((prev) => prev + result.backups.length);
    } catch {
      toast.error('Failed to load more backups');
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, offset]);

  const handleDownload = useCallback(async (backup: SerializedBackup) => {
    if (backup.status !== 'ready' || downloadingId) return;
    setDownloadingId(backup.id);
    try {
      const res = await fetchWithAuth(`/api/drives/${backup.driveId}/backups/${backup.id}/export`);
      if (!res.ok) {
        toast.error('Export failed');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = getExportFilename(backup.id, backup.label);
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Export failed');
    } finally {
      setDownloadingId(null);
    }
  }, [downloadingId]);

  const handleCreateBackup = async () => {
    if (!createDriveId || isCreating) return;
    setIsCreating(true);
    try {
      const result = await post<CreateBackupResult>(`/api/drives/${createDriveId}/backups`, {
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

  if (authLoading) {
    return (
      <div className="container max-w-4xl mx-auto py-10 px-10 flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="container max-w-4xl mx-auto py-10 px-10 space-y-8">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <HardDrive className="h-8 w-8" />
          Drive Backups
        </h1>
        <p className="text-muted-foreground mt-2">
          Create and manage snapshots of your drives. Backups capture all pages, permissions, and members at a point in time.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle>Backups</CardTitle>
            <CardDescription>All backups across your drives</CardDescription>
          </div>
          {!showCreateForm && (
            <Button size="sm" onClick={() => setShowCreateForm(true)} disabled={adminDrives.length === 0}>
              <Plus className="h-4 w-4 mr-2" />
              Create Backup
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {showCreateForm && (
            <div className="space-y-3 p-4 rounded-lg border bg-muted/40">
              <div className="space-y-1.5">
                <Label>Drive</Label>
                {isLoadingDrives ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading drives…
                  </div>
                ) : (
                  <Select value={createDriveId} onValueChange={setCreateDriveId}>
                    <SelectTrigger className="w-full max-w-sm">
                      <SelectValue placeholder="Select a drive" />
                    </SelectTrigger>
                    <SelectContent>
                      {adminDrives.map((drive) => (
                        <SelectItem key={drive.id} value={drive.id}>
                          {drive.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="flex items-end gap-3">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="backup-label">Label <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Input
                    id="backup-label"
                    placeholder="e.g. Before Q2 restructure"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreateBackup();
                      if (e.key === 'Escape') { setShowCreateForm(false); setNewLabel(''); }
                    }}
                    disabled={isCreating}
                    autoFocus
                  />
                </div>
                <Button onClick={handleCreateBackup} disabled={isCreating || !createDriveId}>
                  {isCreating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Snapshot Now
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => { setShowCreateForm(false); setNewLabel(''); }}
                  disabled={isCreating}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {error ? (
            <p className="text-sm text-muted-foreground py-4">Failed to load backups.</p>
          ) : isLoadingBackups ? (
            <div className="flex items-center gap-2 text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading backups…</span>
            </div>
          ) : !accumulatedBackups.length ? (
            <p className="text-sm text-muted-foreground py-4">
              No backups yet. Create one to snapshot a drive&apos;s current state.
            </p>
          ) : (
            <>
              <div className="divide-y">
                {accumulatedBackups.map((backup) => (
                  <div key={backup.id} className="flex items-start justify-between py-3 gap-4">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={statusVariant(backup.status)}>{backup.status}</Badge>
                        <Badge variant="outline">{backup.source}</Badge>
                        {backup.driveName && (
                          <span className="text-sm text-muted-foreground">{backup.driveName}</span>
                        )}
                        {backup.label && (
                          <span className="text-sm font-medium truncate">{backup.label}</span>
                        )}
                      </div>
                      {backup.failureReason && (
                        <p className="text-xs text-destructive">{backup.failureReason}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div
                        className="text-right text-sm text-muted-foreground"
                        title={format(new Date(backup.createdAt), 'PPpp')}
                      >
                        {formatDistanceToNow(new Date(backup.createdAt), { addSuffix: true })}
                      </div>
                      {backup.status !== 'ready' ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <Button size="sm" variant="outline" disabled aria-disabled="true">
                                <Download className="h-3 w-3 mr-1.5" />
                                Download
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Backup not ready</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!!downloadingId}
                          onClick={() => handleDownload(backup)}
                        >
                          {downloadingId === backup.id ? (
                            <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                          ) : (
                            <Download className="h-3 w-3 mr-1.5" />
                          )}
                          {getDownloadButtonLabel(downloadingId === backup.id)}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {data && accumulatedBackups.length < data.total && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-muted-foreground">
                    Showing {accumulatedBackups.length} of {data.total}
                  </span>
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
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
