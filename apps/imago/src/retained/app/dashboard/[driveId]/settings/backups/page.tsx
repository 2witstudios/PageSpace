'use client';
import Link from '@/retained-adapters/link';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from '@/retained-adapters/navigation';
import { Button } from '@/retained/components/ui/button';
import { Input } from '@/retained/components/ui/input';
import { Label } from '@/retained/components/ui/label';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Switch } from '@/retained/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/retained/components/ui/select';
import { Shield, Loader2, Lock } from 'lucide-react';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { fetchWithAuth, post, patch } from '@/retained/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { UpgradeLink } from '@/retained/components/billing/UpgradeLink';
import useSWR from 'swr';
import { format } from 'date-fns';
import {
  SettingsGroup,
  SettingsRow,
  SettingsScreen,
  SettingsSection,
} from '@/ui/settings/settings-screen/settings-screen';

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

/** A backup being created: shown as a pending row until the create request answers. */
type PendingBackup = { readonly label: string | null };

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * The schedule PATCH body: the schedule as it is, with the one change applied. A change of the
 * switch or of the frequency always sends the whole schedule, so the server keeps the rest.
 */
export function scheduleBody(
  schedule: Pick<BackupSchedule, 'enabled' | 'frequency' | 'timezone'>,
  change: Partial<Pick<BackupSchedule, 'enabled' | 'frequency'>>,
): Pick<BackupSchedule, 'enabled' | 'frequency' | 'timezone'> {
  return { enabled: schedule.enabled, frequency: schedule.frequency, timezone: schedule.timezone, ...change };
}

/** A run time in the schedule's own timezone, so "02:00" means 02:00 where the drive runs. */
export function runAtLabel(iso: string | null, timezone: string): string | null {
  if (iso === null) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export const FREQUENCY_LABELS: Readonly<Record<BackupFrequency, string>> = {
  weekly: 'Weekly',
  daily: 'Daily',
  monthly: 'Monthly',
};

const statusPillClass: Readonly<Record<string, string>> = {
  ready: 'bg-status-success/15 text-status-success',
  failed: 'bg-status-danger/15 text-status-danger',
  pending: 'bg-tint text-muted-foreground',
};

// ============================================================================
// Fetchers
// ============================================================================

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
// Automatic backups section
// ============================================================================

function AutomaticBackups({ driveId }: { driveId: string }) {
  const scheduleKey = `/api/drives/${driveId}/backups/schedule`;
  const { data, isLoading, error, mutate } = useSWR<BackupSchedule>(
    scheduleKey,
    scheduleFetcher,
    { revalidateOnFocus: false }
  );

  const save = async (change: Partial<Pick<BackupSchedule, 'enabled' | 'frequency'>>, failed: string) => {
    if (!data) return;
    try {
      await mutate(patch<BackupSchedule>(scheduleKey, scheduleBody(data, change)), {
        optimisticData: { ...data, ...change },
        rollbackOnError: true,
      });
    } catch {
      toast.error(failed);
    }
  };

  if (isLoading) {
    return <Skeleton className="h-28 w-full" />;
  }

  if (error || !data) {
    return null;
  }

  const { available, enabled, frequency, nextRunAt, lastRunAt, timezone } = data;
  const nextLabel = runAtLabel(nextRunAt, timezone);
  const lastLabel = runAtLabel(lastRunAt, timezone);

  return (
    <SettingsSection
      title="Automatic backups"
      description="Runs on a schedule in your timezone. Included in your plan."
      actions={
        <Switch
          aria-label="Automatic backups"
          checked={enabled}
          onCheckedChange={(next) => save({ enabled: next }, 'Failed to update backup schedule')}
          disabled={!available}
        />
      }
    >
      {!available && (
        <p className="text-sm text-muted-foreground">
          <Lock className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
          <UpgradeLink href="/settings/plan" className="underline hover:text-foreground" fallback="Available on paid plans:">
            Upgrade to enable
          </UpgradeLink>{' '}
          daily, weekly, or monthly snapshots.
        </p>
      )}
      {available && enabled && (
        <SettingsGroup label="Schedule">
          <SettingsRow label="Frequency">
            <Select
              value={frequency}
              onValueChange={(next) => save({ frequency: next as BackupFrequency }, 'Failed to update backup frequency')}
            >
              <SelectTrigger aria-label="Frequency" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(FREQUENCY_LABELS) as BackupFrequency[]).map((value) => (
                  <SelectItem key={value} value={value}>{FREQUENCY_LABELS[value]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow label="Next run" hint={timezone}>
            <span className="text-sm text-foreground">{nextLabel ?? 'Not scheduled'}</span>
          </SettingsRow>
          <SettingsRow label="Last run" hint={timezone}>
            <span className="text-sm text-foreground">{lastLabel ?? 'Never'}</span>
          </SettingsRow>
        </SettingsGroup>
      )}
    </SettingsSection>
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
  const [pending, setPending] = useState<PendingBackup | null>(null);
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
    if (pending !== null) return;
    const label = newLabel.trim() || null;
    setPending({ label });
    try {
      const result = await post<CreateBackupResult>(`/api/drives/${driveId}/backups`, {
        source: 'manual',
        label: label ?? undefined,
      });
      toast.success(`Backup created — ${result.counts.pages} pages snapshotted`);
      setNewLabel('');
      setOffset(0);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create backup');
    } finally {
      setPending(null);
    }
  };

  if (isLoading) {
    return (
      <SettingsScreen title="Backups">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
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
      title="Backups"
      lede={`Snapshots of pages, permissions, members, roles and files in ${drive.name}.`}
    >
      <AutomaticBackups driveId={driveId} />

      <SettingsSection title="Create a backup now">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreateBackup();
          }}
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="backup-label" className="text-sm font-medium">
              Label <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="backup-label"
              placeholder="e.g. Before Q2 restructure"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              disabled={pending !== null}
            />
          </div>
          <Button type="submit" disabled={pending !== null}>
            {pending !== null && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create backup
          </Button>
        </form>
      </SettingsSection>

      <SettingsSection title="History" description={`All backups for ${drive.name}`}>
        {error ? (
          <p className="py-4 text-sm text-muted-foreground">Failed to load backups.</p>
        ) : isLoadingBackups && accumulatedBackups.length === 0 && pending === null ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading backups…</span>
          </div>
        ) : accumulatedBackups.length === 0 && pending === null ? (
          <p className="py-4 text-sm text-muted-foreground">No backups yet. Create one above to protect this drive.</p>
        ) : (
          <div className="flex flex-col">
            {pending !== null && <PendingRow label={pending.label} />}
            {accumulatedBackups.map((backup) => (
              <BackupRow key={backup.id} backup={backup} />
            ))}
            {hasMore && (
              <div className="pt-3">
                <Button variant="ghost" size="sm" onClick={handleLoadMore} disabled={isLoadingMore}>
                  {isLoadingMore && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                  Load more
                </Button>
              </div>
            )}
          </div>
        )}
      </SettingsSection>
    </SettingsScreen>
  );
}

const historyRowClass = 'flex min-h-[52px] items-center gap-3 border-b border-border px-2 py-2';

function PendingRow({ label }: { label: string | null }) {
  return (
    <div className={historyRowClass} data-backup-status="pending">
      <StatusPill status="pending" />
      <SourcePill source="manual" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-foreground">{label ?? 'Untitled backup'}</span>
        <span className="text-xs text-muted-foreground">Creating…</span>
      </div>
    </div>
  );
}

function BackupRow({ backup }: { backup: SerializedBackup }) {
  const ready = backup.status === 'ready';
  const meta = backupMeta(backup);
  return (
    <div className={historyRowClass} data-backup-status={backup.status}>
      <StatusPill status={backup.status} />
      <SourcePill source={backup.source} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-foreground">{backup.label ?? 'Untitled backup'}</span>
        <span className={backup.status === 'failed' ? 'text-xs text-status-danger' : 'text-xs text-muted-foreground'}>{meta}</span>
      </div>
      {ready && (
        <Link
          href={`/account/backups/${backup.id}/snapshot`}
          className="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-sm text-foreground hover:bg-tint"
        >
          View &amp; restore
        </Link>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={`inline-flex h-5 flex-none items-center rounded-full px-2 text-[11.5px] font-medium ${statusPillClass[status] ?? 'bg-tint text-muted-foreground'}`}>
      {label}
    </span>
  );
}

function SourcePill({ source }: { source: string }) {
  return (
    <span className="inline-flex h-5 flex-none items-center rounded-full border border-border px-2 font-mono text-[11.5px] text-muted-foreground">
      {source}
    </span>
  );
}

/** The row's second line: when it was made, then when it finished or why it failed. */
export function backupMeta(backup: SerializedBackup): string {
  const created = format(new Date(backup.createdAt), 'MMM d, HH:mm');
  if (backup.status === 'failed') return `${created} · failed${backup.failureReason ? `: ${backup.failureReason}` : ''}`;
  if (backup.status === 'ready' && backup.completedAt) {
    return `${created} · completed ${format(new Date(backup.completedAt), 'HH:mm')}`;
  }
  return created;
}
