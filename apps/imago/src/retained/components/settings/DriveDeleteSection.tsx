'use client';

import { useEffect, useState } from 'react';
import { useRouter } from '@/retained-adapters/navigation';
import Link from '@/retained-adapters/link';
import { Button } from '@/retained/components/ui/button';
import { Input } from '@/retained/components/ui/input';
import { Label } from '@/retained/components/ui/label';
import { toast } from 'sonner';
import { del, fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { useDriveStore } from '@/retained/hooks/useDrive';
import {
  countTreePages,
  deleteConsequences,
  isExactNameConfirmed,
  latestFinishedBackupAt,
  safetyNetParts,
  type DeleteCounts,
} from './drive-delete-model';

interface DriveDeleteSectionProps {
  driveId: string;
  driveName: string;
}

const readJson = async (url: string): Promise<unknown> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
};

/** The array under `key` in a JSON object, or an empty list when the shape is not what we expect. */
const listAt = (data: unknown, key: string): unknown[] => {
  if (typeof data !== 'object' || data === null) return [];
  const value: unknown = Reflect.get(data, key);
  return Array.isArray(value) ? value : [];
};

const roleOf = (member: unknown): string | null =>
  typeof member === 'object' && member !== null && 'role' in member && typeof member.role === 'string' ? member.role : null;

const backupsOf = (data: unknown): { status: string; completedAt: string | null }[] =>
  listAt(data, 'backups').flatMap((backup) => {
    if (typeof backup !== 'object' || backup === null) return [];
    const status = 'status' in backup && typeof backup.status === 'string' ? backup.status : null;
    const completedAt = 'completedAt' in backup && typeof backup.completedAt === 'string' ? backup.completedAt : null;
    return status === null ? [] : [{ status, completedAt }];
  });

/**
 * The owner's delete form: the real consequences, the last backup, and a delete that
 * stays disabled until the drive's exact name is typed. Deleting moves the drive to trash.
 */
export function DriveDeleteSection({ driveId, driveName }: DriveDeleteSectionProps) {
  const [counts, setCounts] = useState<DeleteCounts | null>(null);
  const [countsFailed, setCountsFailed] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const router = useRouter();
  const removeDrive = useDriveStore((state) => state.removeDrive);

  useEffect(() => {
    let cancelled = false;
    const base = `/api/drives/${driveId}`;
    Promise.all([
      readJson(`${base}/members`),
      readJson(`${base}/agents/members`),
      readJson(`${base}/apps/members`),
      readJson(`${base}/pages`),
      readJson(`${base}/backups`),
    ])
      .then(([members, agents, apps, pages, backups]) => {
        if (cancelled) return;
        const memberRows = listAt(members, 'members');
        const guests = memberRows.filter((row) => roleOf(row) === 'GUEST').length;
        setCounts({
          pages: countTreePages(pages),
          people: memberRows.length - guests,
          guests,
          agents: listAt(agents, 'agentMembers').length,
          apps: listAt(apps, 'appMembers').length,
        });
        setLastBackupAt(latestFinishedBackupAt(backupsOf(backups)));
      })
      .catch(() => {
        if (!cancelled) setCountsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [driveId]);

  const confirmed = isExactNameConfirmed(driveName, typed);

  const handleDelete = async () => {
    if (!confirmed || isDeleting) return;
    setIsDeleting(true);
    try {
      await del(`/api/drives/${driveId}`);
      toast.success('The drive has been moved to trash.');
      removeDrive(driveId);
      router.push('/dashboard');
    } catch (error) {
      console.error('Error deleting drive:', error);
      toast.error('Failed to delete drive. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  };

  const safetyNet = safetyNetParts(lastBackupAt);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-muted-foreground">
        <p className="mb-2">Deleting this drive will:</p>
        {counts === null ? (
          <p className="text-xs">{countsFailed ? 'The counts could not be loaded.' : 'Counting what this drive holds…'}</p>
        ) : (
          <ul className="list-disc list-inside space-y-1 ml-2">
            {deleteConsequences(counts).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="drive-delete-confirm">
          Type <code className="font-mono">{driveName}</code> to confirm
        </Label>
        <div className="flex gap-2">
          <Input
            id="drive-delete-confirm"
            type="text"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            disabled={isDeleting}
            autoComplete="off"
          />
          <Button variant="destructive" onClick={handleDelete} disabled={!confirmed || isDeleting}>
            {isDeleting ? 'Deleting drive…' : 'Delete drive'}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {safetyNet.lead}
        <Link href={`/${driveId}/settings/backups`} className="underline">
          {safetyNet.linkText}
        </Link>
        {safetyNet.tail}
      </p>
    </div>
  );
}
