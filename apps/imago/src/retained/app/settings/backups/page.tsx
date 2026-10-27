'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/retained/hooks/useAuth';
import { useRouter, useSearchParams } from '@/retained-adapters/navigation';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { Button } from '@/retained/components/ui/button';
import { Input } from '@/retained/components/ui/input';
import { Label } from '@/retained/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/retained/components/ui/select';
import { toast } from 'sonner';
import { Loader2, Plus } from 'lucide-react';
import useSWR from 'swr';
import { fetchWithAuth, post } from '@/retained/lib/auth/auth-fetch';
import { SettingsGroup, SettingsScreen, SettingsSection } from '@/ui/settings/settings-screen/settings-screen';
import { BackupRow } from './BackupRow';
import { BackupRestorePreview } from './BackupRestorePreview';
import { getExportFilename, type SerializedBackup } from './utils';

const PAGE_SIZE = 50;

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

export default function BackupsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [isRestoring, setIsRestoring] = useState(false);

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
      a.download = getExportFilename(backup.id, backup.label, backup.driveSlug);
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Export failed');
    } finally {
      setDownloadingId(null);
    }
  }, [downloadingId]);

  const restoreTargetId = searchParams.get('restore');
  const restoreBackup = restoreTargetId
    ? accumulatedBackups.find((b) => b.id === restoreTargetId) ?? null
    : null;

  const handleRestore = useCallback(async (backupId: string) => {
    if (!restoreBackup || isRestoring) return;
    setIsRestoring(true);
    try {
      await post(`/api/drives/${restoreBackup.driveId}/backups/${backupId}/restore`, {});
      toast.success('Drive restored successfully');
      router.replace('/settings/backups');
      setAccumulatedBackups([]);
      setOffset(0);
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setIsRestoring(false);
    }
  }, [restoreBackup, isRestoring, router, mutate]);

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

  if (authLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const total = data?.total ?? 0;

  return (
    <SettingsScreen
      title="Backups"
      lede="Snapshots of your drives. A backup captures every page, permission and member at a point in time."
      actions={
        showCreateForm ? null : (
          <Button size="sm" onClick={() => setShowCreateForm(true)} disabled={adminDrives.length === 0}>
            <Plus className="mr-2 h-4 w-4" />
            Create backup
          </Button>
        )
      }
    >
      {showCreateForm && (
        <form
          aria-label="Create backup"
          className="flex flex-wrap items-end gap-3 rounded-xl border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreateBackup();
          }}
        >
          <div className="flex w-44 flex-col gap-1.5">
            <Label>Drive</Label>
            {isLoadingDrives ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading drives…
              </div>
            ) : (
              <Select value={createDriveId} onValueChange={setCreateDriveId}>
                <SelectTrigger className="w-full">
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
          <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
            <Label htmlFor="backup-label">
              Label <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="backup-label"
              placeholder="e.g. Before Q2 restructure"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setShowCreateForm(false); setNewLabel(''); }
              }}
              disabled={isCreating}
              autoFocus
            />
          </div>
          <Button type="submit" disabled={isCreating || !createDriveId}>
            {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Snapshot now
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => { setShowCreateForm(false); setNewLabel(''); }}
            disabled={isCreating}
          >
            Cancel
          </Button>
        </form>
      )}

      <SettingsSection
        title="All backups"
        description={`${total} total`}
      >
        {error ? (
          <p className="py-4 text-sm text-muted-foreground">Failed to load backups.</p>
        ) : isLoadingBackups ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading backups…</span>
          </div>
        ) : accumulatedBackups.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            No backups yet. Create one to snapshot a drive&apos;s current state.
          </p>
        ) : (
          <>
            <SettingsGroup label="All backups">
              {accumulatedBackups.map((backup) => (
                <BackupRow
                  key={backup.id}
                  backup={backup}
                  downloading={downloadingId === backup.id}
                  anyDownloading={downloadingId !== null}
                  onView={(b) => router.push(`/settings/backups/${b.id}/snapshot`)}
                  onDownload={handleDownload}
                  onRestore={(b) => router.push(`/settings/backups?restore=${b.id}`)}
                >
                  {restoreBackup?.id === backup.id && backup.status === 'ready' && (
                    <BackupRestorePreview
                      driveId={backup.driveId}
                      backup={backup}
                      restoring={isRestoring}
                      onRestore={handleRestore}
                      onCancel={() => router.replace('/settings/backups')}
                    />
                  )}
                </BackupRow>
              ))}
            </SettingsGroup>
            {data && accumulatedBackups.length < data.total && (
              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-muted-foreground">
                  Showing {accumulatedBackups.length} of {data.total}
                </span>
                <Button variant="ghost" size="sm" onClick={handleLoadMore} disabled={isLoadingMore}>
                  {isLoadingMore && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </SettingsSection>
    </SettingsScreen>
  );
}
