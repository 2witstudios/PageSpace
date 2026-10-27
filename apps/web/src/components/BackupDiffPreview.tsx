'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { RestoreDiff } from '@/services/api/restore-diff-service';

export type DiffSummary = {
  total: number;
  orphanCount: number;
  unchangedCount: number;
};

export function buildDiffSummary(diff: RestoreDiff): DiffSummary {
  return {
    total: diff.toCreate.length + diff.toOverwrite.length,
    orphanCount: diff.toOrphan.length,
    unchangedCount: diff.unchanged.length,
  };
}

type Phase =
  | { name: 'idle' }
  | { name: 'loading' }
  | { name: 'loaded'; diff: RestoreDiff; summary: DiffSummary }
  | { name: 'confirming'; diff: RestoreDiff; summary: DiffSummary };

interface BackupDiffPreviewProps {
  driveId: string;
  backup: { id: string; status: string };
  onRestore?: (backupId: string) => void;
}

export function BackupDiffPreview({ driveId, backup, onRestore }: BackupDiffPreviewProps) {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });

  if (backup.status !== 'ready') {
    return null;
  }

  async function handlePreview() {
    setPhase({ name: 'loading' });
    try {
      const res = await fetchWithAuth(
        `/api/drives/${driveId}/backups/${backup.id}/diff`,
      );
      if (!res.ok) {
        toast.error('Failed to load diff preview');
        setPhase({ name: 'idle' });
        return;
      }
      const { diff } = (await res.json()) as { diff: RestoreDiff };
      setPhase({ name: 'loaded', diff, summary: buildDiffSummary(diff) });
    } catch {
      toast.error('Failed to load diff preview');
      setPhase({ name: 'idle' });
    }
  }

  function handleCancel() {
    setPhase({ name: 'idle' });
  }

  if (phase.name === 'idle') {
    return (
      <Button variant="outline" size="sm" onClick={handlePreview}>
        Preview restore
      </Button>
    );
  }

  if (phase.name === 'loading') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading diff…</span>
      </div>
    );
  }

  const { summary } = phase;

  return (
    <div className="space-y-2 text-sm">
      <p>{summary.total} pages will be restored from snapshot</p>

      {summary.orphanCount > 0 && (
        <p className="text-amber-600">
          {summary.orphanCount} pages added since backup will be soft-deleted
        </p>
      )}

      {summary.unchangedCount > 0 && (
        <p className="text-muted-foreground">{summary.unchangedCount} pages unchanged</p>
      )}

      <div className="flex gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={handleCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => onRestore?.(backup.id)}
        >
          Restore now
        </Button>
      </div>
    </div>
  );
}
