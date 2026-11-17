'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmActionDialog } from '@/components/admin/users/confirm-action-dialog';
import { mergeReportPages, type ReportedCaseSummary, type ReportSummary } from '@/lib/content/report-summary';
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

type Pending = { caseId: string; outcome: 'dismissed' | 'actioned'; reportCount: number } | null;

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
 * A case's reports: the first page from the queue, then later pages on request, so a report past the first page
 * is never out of reach of the admin who closes the case.
 */
function CaseReports({ caseId, reportCount, firstPage }: { caseId: string; reportCount: number; firstPage: ReportSummary[] }) {
  const [later, setLater] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reports = mergeReportPages(firstPage, later);
  const remaining = reportCount - reports.length;

  const loadMore = async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchCaseReports(caseId, reports.length);
      setLater((current) => mergeReportPages(current, page));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <ul className="space-y-2">
        {reports.map((report) => (
          <ReportItem key={report.id} report={report} />
        ))}
      </ul>
      {remaining > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            Showing the latest {reports.length} of {reportCount}.
          </p>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void loadMore()}>
            {loading ? 'Loading…' : `Show ${Math.min(remaining, 50)} more report${Math.min(remaining, 50) === 1 ? '' : 's'}`}
          </Button>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}

interface ReportQueueProps {
  items: ReportedCaseSummary[];
  onChanged: () => void;
  /** Open the Take down tab on this case's target, where the existing takedown actions are. */
  onReview: (targetId: string) => void;
}

/** Cases opened by reports and waiting for staff, CSAM first. Metadata and the reporters' words only. */
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
      await closeReportedCase({ caseId: dialog.caseId, outcome: dialog.outcome, expectedReportCount: dialog.reportCount, note });
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
      {items.map(({ case: item, reportCount, reports }) => (
        <Card key={item.id} data-testid="reported-case">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {item.category === 'csam' && <Badge variant="destructive">CSAM</Badge>}
                  <span>
                    {reportCount} report{reportCount === 1 ? '' : 's'}
                  </span>
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
                  <Button size="sm" onClick={() => onReview(item.targetId)}>
                    Review and act
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setDialogError(null); setDialog({ caseId: item.id, outcome: 'actioned', reportCount }); }}>
                    Mark actioned
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setDialogError(null); setDialog({ caseId: item.id, outcome: 'dismissed', reportCount }); }}>
                    Dismiss
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <CaseReports caseId={item.id} reportCount={reportCount} firstPage={reports} />
          </CardContent>
        </Card>
      ))}

      <ConfirmActionDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        title={DIALOG_COPY[dialog?.outcome ?? 'dismissed'].title}
        description={<span>{DIALOG_COPY[dialog?.outcome ?? 'dismissed'].description}</span>}
        confirmLabel={DIALOG_COPY[dialog?.outcome ?? 'dismissed'].confirmLabel}
        destructive={false}
        reasonLabel="Note (kept on the case)"
        pending={pending}
        error={dialogError}
        onConfirm={({ reason }) => void close(reason)}
      />
    </div>
  );
}
