"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatCard, DataState } from "@/components/admin/kit";
import { StatusBadge } from "@/components/admin/broadcasts/status-badge";
import { ConfirmActionDialog, type ConfirmActionValues } from "@/components/admin/users/confirm-action-dialog";
import { useAdminQuery } from "@/hooks/use-admin-query";
import { post } from "@/lib/auth/auth-fetch";
import { num } from "@/lib/format";
import { isPollingSettled, isTerminalStatus, type BroadcastDetail } from "@/components/admin/broadcasts/types";

const STEP_ICON = {
  ok: CheckCircle2,
  failed: XCircle,
  skipped: CircleDashed,
} as const;

export function BroadcastProgress({ broadcastId }: { broadcastId: string }) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Polls every 2s until the row reaches a terminal status, then the effect
  // below drops the interval to 0 and useAdminQuery stops fetching.
  const [refreshInterval, setRefreshInterval] = useState(2000);

  const { data, isLoading, isFetching, error, refetch } = useAdminQuery<BroadcastDetail>(
    `/api/admin/broadcasts/${broadcastId}`,
    { refreshInterval },
  );

  useEffect(() => {
    if (data && isPollingSettled(data.status, data.blockedReason) && refreshInterval !== 0) {
      setRefreshInterval(0);
    }
  }, [data, refreshInterval]);

  async function handleCancel({ reason }: ConfirmActionValues) {
    setCancelPending(true);
    setCancelError(null);
    try {
      await post(`/api/admin/broadcasts/${broadcastId}`, { action: "cancel", reason });
      setCancelOpen(false);
      refetch();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Failed to cancel");
    } finally {
      setCancelPending(false);
    }
  }

  const canCancel = !!data && !isTerminalStatus(data.status);

  return (
    <div className="space-y-6">
      <DataState
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        hasData={!!data}
      >
        {data && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <StatusBadge status={data.status} />
                <h2 className="text-lg font-semibold">{data.subject || "(untitled)"}</h2>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={refetch} disabled={isFetching}>
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
                {canCancel && (
                  <Button variant="destructive" size="sm" onClick={() => setCancelOpen(true)}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>

            {data.dryRun && (
              <Alert>
                <AlertTitle>Dry run</AlertTitle>
                <AlertDescription>This broadcast was never enqueued — no email was sent.</AlertDescription>
              </Alert>
            )}

            {data.blockedReason && (
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Blocked</AlertTitle>
                <AlertDescription>{data.blockedReason}</AlertDescription>
              </Alert>
            )}

            {data.lastError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Last error</AlertTitle>
                <AlertDescription>{data.lastError}</AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <StatCard label="Targeted" value={num(data.totalTargeted)} />
              <StatCard label="Sent" value={num(data.sentCount)} tone="positive" />
              <StatCard label="Skipped" value={num(data.skippedCount)} tone="warning" />
              <StatCard label="Failed" value={num(data.failedCount)} tone={data.failedCount > 0 ? "negative" : "default"} />
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <Detail label="Engine" value={data.engine === "transactional" ? "Transactional" : "Marketing (Resend)"} />
                <Detail label="Content" value={data.contentMode === "compose" ? "Composed" : "Template"} />
                <Detail label="Attempts" value={String(data.attempts)} />
                <Detail label="Send limit" value={data.sendLimit != null ? num(data.sendLimit) : "None"} />
                <Detail label="Delay" value={data.delayMs != null ? `${data.delayMs}ms` : "Default"} />
                <Detail label="Created" value={new Date(data.createdAt).toLocaleString()} />
                <Detail label="Started" value={data.startedAt ? new Date(data.startedAt).toLocaleString() : "—"} />
                <Detail label="Completed" value={data.completedAt ? new Date(data.completedAt).toLocaleString() : "—"} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Step log</CardTitle>
                <CardDescription>Progress recorded by the worker as it processes this broadcast.</CardDescription>
              </CardHeader>
              <CardContent>
                {data.stepResults.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No steps recorded yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {data.stepResults.map((step, i) => {
                      const Icon = STEP_ICON[step.status];
                      return (
                        <li key={i} className="flex items-start gap-2 text-sm">
                          <Icon
                            className={`mt-0.5 h-4 w-4 shrink-0 ${
                              step.status === "ok" ? "text-success" : step.status === "failed" ? "text-destructive" : "text-muted-foreground"
                            }`}
                          />
                          <div className="min-w-0">
                            <span className="font-medium">{step.step}</span>
                            {step.detail && <span className="text-muted-foreground"> — {step.detail}</span>}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {new Date(step.at).toLocaleTimeString()}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </DataState>

      <ConfirmActionDialog
        open={cancelOpen}
        onOpenChange={(open) => !cancelPending && setCancelOpen(open)}
        title="Cancel this broadcast?"
        description="The worker checks this status between batches and stops sending. Recipients already sent to are not affected."
        confirmLabel="Cancel broadcast"
        requireReason
        reasonPlaceholder="Why is this broadcast being cancelled?"
        pending={cancelPending}
        error={cancelError}
        onConfirm={(values) => void handleCancel(values)}
      />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
