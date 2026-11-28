'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmActionDialog } from '@/components/admin/users/confirm-action-dialog';
import { mergeReportPages, type ReportedCaseSummary, type ReportSummary, type ScanFlagSummary } from '@/lib/content/report-summary';
import { closeReportedCase, fetchCaseReports, ReportedCaseChangedError } from './actions';
import { Mono } from './case-list';

const CATEGORY_LABELS: Record<ReportSummary['category'], string> = {
  csam: 'CSAM',
  illegal_other: 'Other illegal content',
  malware: 'Malware or phishing',
  copyright: 'Copyright',
  harassment: 'Harassment or abuse',
  other: 'Other',
};

/** A reported case's target and the content hash its report named, for the Take down tab. */
export interface ReviewTarget {
  targetId: string;
  reportedHash: string | null;
}

type CloseRequest = { caseId: string; outcome: 'dismissed' | 'actioned'; reportCount: number; scanFlaggedAt: string | null };
type Pending = CloseRequest | null;

const DIALOG_COPY: Record<NonNullable<Pending>['outcome'], { title: string; description: string; confirmLabel: string }> = {
  actioned: {
    title: 'Mark this report as actioned?',
    description:
      'Closes the report. It does not take anything down by itself: run the takedown first from "Review and act". Further reports on the same target open a new case.',
    confirmLabel: 'Mark actioned',
  },
  dismissed: {
    title: 'Dismiss this report?',
    description: 'Closes the report with no action. Further reports on the same target open a new case.',
    confirmLabel: 'Dismiss',
  },
};

/** Dismissing a flagged scan clears the hash, so the dialog says so. */
const SCAN_DISMISS_COPY = {
  title: 'Dismiss this flag as a false positive?',
  description:
    'Closes the case and records the file as clean, so it can be published. It is scanned again when that clean verdict expires. Further reports on the same file open a new case.',
  confirmLabel: 'Dismiss',
};

const dialogCopy = (pending: Pending) =>
  pending?.scanFlaggedAt && pending.outcome === 'dismissed' ? SCAN_DISMISS_COPY : DIALOG_COPY[pending?.outcome ?? 'dismissed'];

/** What the publish scan found: a classifier score, never the file. */
function ScanFlag({ scan }: { scan: ScanFlagSummary }) {
  return (
    <p className="rounded-md border p-3 text-sm" data-testid="scan-flag">
      The publish scan&apos;s classifier scored this file <strong>{scan.category}</strong> at{' '}
      <Mono>{scan.score.toFixed(3)}</Mono> ({scan.provider}, {scan.mode} mode, {new Date(scan.flaggedAt).toLocaleString()}).{' '}
      {scan.mode === 'enforce'
        ? 'It was held back from the public bucket.'
        : 'Shadow mode: it was published. Review and act if it needs to come down.'}{' '}
      A classifier score is not a confirmed match; nothing has been blocked.
    </p>
  );
}

/**
 * One report. The reporter's text may be abusive or contain URLs: it is
 * rendered as a plain text node — never as markup, never as a link.
 */
function ReportItem({ report }: { report: ReportSummary }) {
  return (
    <li className="space-y-1 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={report.category === 'csam' ? 'destructive' : 'outline'}>{CATEGORY_LABELS[report.category]}</Badge>
        <span>{new Date(report.createdAt).toLocaleString()}</span>
        <span>
          {report.reporterUserId ? (
            <>
              by user <Mono>{report.reporterUserId}</Mono>
            </>
          ) : (
            'anonymous'
          )}
        </span>
        {report.contactEmail && (
          <span>
            contact <Mono>{report.contactEmail}</Mono>
          </span>
        )}
      </div>
      {report.description ? (
        <p className="whitespace-pre-wrap break-words text-sm" data-testid="report-text">
          {report.description}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">No details given.</p>
      )}
    </li>
  );
}

/**
 * One case under review. Its first page of reports comes with the queue; later pages load on request, keyed on
 * the last report shown. The case cannot be closed until every report on it is on screen, so a close never
 * acknowledges a report nobody saw. The queue keys this card on its first page, so a refresh starts paging afresh.
 */
function ReportedCaseCard({
  summary: { case: item, reportCount, reports: firstPage, scan },
  onClose,
  onReview,
}: {
  summary: ReportedCaseSummary;
  onClose: (request: CloseRequest) => void;
  onReview: (target: ReviewTarget) => void;
}) {
  const [later, setLater] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reports = mergeReportPages(firstPage, later);
  const remaining = Math.max(reportCount - reports.length, 0);
  const nextPage = Math.min(remaining, 50);

  const loadMore = async () => {
    const last = reports[reports.length - 1];
    if (!last) return;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchCaseReports(item.id, last.id);
      if (page.length === 0) setError('No older reports were found. Refresh the queue.');
      setLater((current) => mergeReportPages(current, page));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card data-testid="reported-case">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {item.category === 'csam' && <Badge variant="destructive">CSAM</Badge>}
              {scan && <Badge variant="outline">Flagged by publish scan</Badge>}
              {(reportCount > 0 || !scan) && (
                <span>
                  {reportCount} report{reportCount === 1 ? '' : 's'}
                </span>
              )}
            </CardTitle>
            <CardDescription className="space-y-0.5">
              <span className="block">
                Case <Mono>{item.id}</Mono>, opened {new Date(item.createdAt).toLocaleString()}
              </span>
              <span className="block">
                {item.targetType.replace('_', ' ')} <Mono>{item.targetId}</Mono>
              </span>
            </CardDescription>
          </div>
          {item.status === 'reported' && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => onReview({ targetId: item.targetId, reportedHash: item.contentHash })}>
                Review and act
              </Button>
              <Button size="sm" variant="outline" disabled={remaining > 0} onClick={() => onClose({ caseId: item.id, outcome: 'actioned', reportCount, scanFlaggedAt: scan?.flaggedAt ?? null })}>
                Mark actioned
              </Button>
              <Button size="sm" variant="ghost" disabled={remaining > 0} onClick={() => onClose({ caseId: item.id, outcome: 'dismissed', reportCount, scanFlaggedAt: scan?.flaggedAt ?? null })}>
                Dismiss
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {scan && <ScanFlag scan={scan} />}
        <ul className="space-y-2">
          {reports.map((report) => (
            <ReportItem key={report.id} report={report} />
          ))}
        </ul>
        {remaining > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">
              Showing the latest {reports.length} of {reportCount}.
              {item.status === 'reported' && ' Show every report before closing this case.'}
            </p>
            <Button size="sm" variant="outline" disabled={loading} onClick={() => void loadMore()}>
              {loading ? 'Loading…' : `Show ${nextPage} more report${nextPage === 1 ? '' : 's'}`}
            </Button>
            {error && (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface ReportQueueProps {
  items: ReportedCaseSummary[];
  onChanged: () => void;
  /** Open the Take down tab on this case's target, where the existing takedown actions are. */
  onReview: (target: ReviewTarget) => void;
}

/**
 * Cases waiting for staff, CSAM first: opened by reports, or by the publish scan's classifier.
 * Metadata, scores and the reporters' words only; never a preview.
 */
export function ReportQueue({ items, onChanged, onReview }: ReportQueueProps) {
  const [dialog, setDialog] = useState<Pending>(null);
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const close = async (note: string) => {
    if (!dialog) return;
    setPending(true);
    setDialogError(null);
    setNotice(null);
    try {
      await closeReportedCase({
        caseId: dialog.caseId,
        outcome: dialog.outcome,
        expectedReportCount: dialog.reportCount,
        expectedScanFlaggedAt: dialog.scanFlaggedAt,
        note,
      });
      setDialog(null);
      onChanged();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed';
      if (error instanceof ReportedCaseChangedError) {
        // The count this dialog holds is stale: close it and show the new reports, so a retry starts fresh.
        setDialog(null);
        setNotice(message);
        onChanged();
      } else {
        setDialogError(message);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-4">
      {notice && (
        <p className="text-sm text-amber-700 dark:text-amber-400" role="status">
          {notice}
        </p>
      )}
      {items.map((summary) => (
        <ReportedCaseCard
          // A refreshed first page (new reports, a new count or a new scan flag) remounts the card and drops pages loaded before it.
          key={`${summary.case.id}:${summary.reportCount}:${summary.reports[0]?.id ?? ''}:${summary.scan?.flaggedAt ?? ''}`}
          summary={summary}
          onReview={onReview}
          onClose={(request) => {
            setDialogError(null);
            setDialog(request);
          }}
        />
      ))}

      <ConfirmActionDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        title={dialogCopy(dialog).title}
        description={<span>{dialogCopy(dialog).description}</span>}
        confirmLabel={dialogCopy(dialog).confirmLabel}
        destructive={false}
        reasonLabel="Note (kept on the case)"
        pending={pending}
        error={dialogError}
        onConfirm={({ reason }) => void close(reason)}
      />
    </div>
  );
}
