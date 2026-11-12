'use client';

import { useState } from 'react';
import { Check, Circle, Minus, RotateCw, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CaseSummary } from '@/lib/content/case-summary';
import { ConfirmActionDialog } from '@/components/admin/users/confirm-action-dialog';
import { describeTakedownResult, runTakedown } from './actions';

const STATUS_LABELS: Record<CaseSummary['status'], string> = {
  open: 'Open',
  awaiting_evidence: 'Awaiting evidence storage',
  actioned: 'Actioned',
  dismissed: 'Dismissed',
};

const KIND_LABELS: Record<string, string> = {
  global: 'Global takedown',
  unpublish_page: 'Unpublish page',
  park_drive: 'Park drive sites',
  avatar: 'Avatar takedown',
  park_user_sites: 'Park user sites (suspension)',
};

function statusVariant(status: CaseSummary['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'actioned') return 'secondary';
  if (status === 'dismissed') return 'outline';
  return 'destructive';
}

function StepIcon({ status }: { status: string }) {
  if (status === 'ok') return <Check className="h-3.5 w-3.5 text-emerald-600" aria-label="done" />;
  if (status === 'failed') return <X className="h-3.5 w-3.5 text-destructive" aria-label="failed" />;
  if (status === 'skipped') return <Minus className="h-3.5 w-3.5 text-muted-foreground" aria-label="skipped" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/50" aria-label="pending" />;
}

/** IDs and hashes are shown as plain monospace text — never as links. */
export function Mono({ children }: { children: React.ReactNode }) {
  return <span className="break-all font-mono text-xs">{children}</span>;
}

const DIALOG_COPY: Record<NonNullable<Pending>['action'], { title: string; description: string; confirmLabel: string }> = {
  resume: {
    title: 'Resume this case?',
    description: 'Continues the takedown from the first step that has not succeeded. Steps already done are not repeated.',
    confirmLabel: 'Resume case',
  },
  resweep: {
    title: 'Pass over storage again?',
    description:
      'Checks both buckets again for this hash and deletes anything that arrived after the takedown. This also runs automatically about 20 minutes after a takedown finishes.',
    confirmLabel: 'Re-sweep',
  },
  restore_drive: {
    title: "Lift this case's hold on the drive?",
    description:
      "Removes the hold this case placed. The drive's sites go back on the web only if nothing else holds them: another takedown case, or the owner's suspension, keeps them parked.",
    confirmLabel: 'Restore sites',
  },
};

interface CaseListProps {
  cases: CaseSummary[];
  onChanged: () => void;
}

type Pending = { caseId: string; action: 'resume' | 'resweep' | 'restore_drive' } | null;

/** Cases with status and step progress, and "resume" for the ones that stopped part-way. */
export function CaseList({ cases, onChanged }: CaseListProps) {
  const [dialog, setDialog] = useState<Pending>(null);
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; ok: boolean } | null>(null);

  const run = async (reason: string) => {
    if (!dialog) return;
    setPending(true);
    setDialogError(null);
    try {
      const result = await runTakedown(
        dialog.action === 'restore_drive'
          ? { action: 'restore_drive', caseId: dialog.caseId, reason }
          : { action: dialog.action, caseId: dialog.caseId },
      );
      setNotice(describeTakedownResult(result));
      setDialog(null);
      onChanged();
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3">
      {notice && (
        <p className={`text-sm ${notice.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}`} role="status">
          {notice.message}
        </p>
      )}

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Opened</TableHead>
              <TableHead>Case</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Steps</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cases.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="whitespace-nowrap text-xs">{new Date(item.createdAt).toLocaleString()}</TableCell>
                <TableCell>
                  <Mono>{item.id}</Mono>
                  <div className="text-xs text-muted-foreground">
                    {item.progress.kind ? KIND_LABELS[item.progress.kind] : 'Report only'}
                  </div>
                </TableCell>
                <TableCell className="max-w-[16rem]">
                  <div className="text-xs text-muted-foreground">{item.targetType.replace('_', ' ')}</div>
                  <Mono>{item.targetId}</Mono>
                  {item.references && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {item.references.pageIds.length} page(s), {item.references.driveIds.length} drive(s),{' '}
                      {item.references.uploaderUserIds.length} user(s)
                      {item.references.truncated ? ' (truncated)' : ''}
                    </div>
                  )}
                  {item.skippedDrives.length > 0 && (
                    <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                      Left published, needs a decision: {item.skippedDrives.map((d) => d.driveId).join(', ')}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-xs">{item.category ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(item.status)}>{STATUS_LABELS[item.status]}</Badge>
                  {item.evidencePreserved && <div className="mt-1 text-xs text-muted-foreground">Copy preserved</div>}
                </TableCell>
                <TableCell>
                  <ul className="space-y-0.5">
                    {item.progress.steps.map((step) => (
                      <li key={step.step} className="flex items-start gap-1.5 text-xs">
                        <span className="mt-0.5"><StepIcon status={step.status} /></span>
                        <span>
                          {step.step.replaceAll('_', ' ')}
                          {step.detail && <span className="block text-destructive">{step.detail}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </TableCell>
                <TableCell className="text-right">
                  {item.progress.resumable && (
                    <Button size="sm" variant="outline" onClick={() => { setDialogError(null); setDialog({ caseId: item.id, action: 'resume' }); }}>
                      <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Resume
                    </Button>
                  )}
                  {item.progress.restorable && (
                    <Button size="sm" variant="outline" onClick={() => { setDialogError(null); setDialog({ caseId: item.id, action: 'restore_drive' }); }}>
                      Restore sites
                    </Button>
                  )}
                  {item.progress.resweepable && (
                    <Button size="sm" variant="ghost" onClick={() => { setDialogError(null); setDialog({ caseId: item.id, action: 'resweep' }); }}>
                      Re-sweep
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ConfirmActionDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        title={DIALOG_COPY[dialog?.action ?? 'resume'].title}
        description={<span>{DIALOG_COPY[dialog?.action ?? 'resume'].description}</span>}
        confirmLabel={DIALOG_COPY[dialog?.action ?? 'resume'].confirmLabel}
        destructive={dialog?.action !== 'restore_drive'}
        requireReason={dialog?.action === 'restore_drive'}
        pending={pending}
        error={dialogError}
        onConfirm={({ reason }) => void run(reason)}
      />
    </div>
  );
}
