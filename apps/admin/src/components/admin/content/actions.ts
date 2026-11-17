'use client';

import type { TakedownRequest, TakedownResponse } from '@pagespace/lib/content-safety/takedown-request';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { ReportSummary } from '@/lib/content/report-summary';

/**
 * Run a takedown action. Throws with the server's message when the request was
 * refused or never ran; a step that failed part-way is NOT thrown — it comes
 * back as `{ status: 'open', failedStep }` so the caller can offer "resume".
 */
export async function runTakedown(request: TakedownRequest): Promise<TakedownResponse> {
  const res = await fetchWithAuth('/api/admin/content/takedown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const data = (await res.json().catch(() => null)) as (TakedownResponse & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

/** One line an admin can read for what a takedown did. */
export function describeTakedownResult(result: TakedownResponse): { message: string; ok: boolean } {
  const caseRef = result.caseId ? ` Case ${result.caseId}.` : '';
  if (result.inProgress) {
    return {
      ok: false,
      message: `This case is already running, so this request did not start another run. Any new category or options were saved, and the running takedown reads them before its next step.${caseRef} Check the Cases tab in a moment.`,
    };
  }
  if (result.failedStep) {
    return { ok: false, message: `Stopped at step "${result.failedStep}": ${result.error ?? 'unknown error'}.${caseRef} Resume it from the Cases tab.` };
  }
  if (result.haltReason === 'awaiting_evidence') {
    return {
      ok: false,
      message: `Blocked, but nothing was deleted: this category must be preserved first and no evidence storage (EVIDENCE_BUCKET) is configured.${caseRef} Resume once it is.`,
    };
  }
  if (result.haltReason === 'preservation_decision_required') {
    return {
      ok: false,
      message: `Blocked, but nothing was deleted: no evidence storage is configured. Run it again with "skip preservation" and a reason, or configure EVIDENCE_BUCKET and resume.${caseRef}`,
    };
  }
  if (result.stillHeldDriveIds?.length) {
    return { ok: true, message: `Hold lifted, but ${result.stillHeldDriveIds.length} drive(s) stay parked: another case or the owner's suspension still holds them.` };
  }
  if (result.restoredDriveIds) return { ok: true, message: `Restored the published sites of ${result.restoredDriveIds.length} drive(s).` };
  return { ok: true, message: `Done.${caseRef}` };
}

/** The server refused a close because reports arrived after the admin opened the case (409). */
export class ReportedCaseChangedError extends Error {}

/** Close a case under review: `actioned` once a takedown has been run for it, `dismissed` for no violation. */
export async function closeReportedCase(input: {
  caseId: string;
  outcome: 'dismissed' | 'actioned';
  /** The count the admin was shown; the server refuses the close if more reports arrived since. */
  expectedReportCount: number;
  note: string;
}): Promise<void> {
  const res = await fetchWithAuth('/api/admin/content/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    const message = data?.error ?? `Request failed (${res.status})`;
    throw res.status === 409 ? new ReportedCaseChangedError(message) : new Error(message);
  }
}

/** One case's reports older than `beforeId`, the last one the queue shows; newest first. */
export async function fetchCaseReports(caseId: string, beforeId: string): Promise<ReportSummary[]> {
  const query = new URLSearchParams({ id: caseId, reportsBefore: beforeId, reportsLimit: '50' });
  const res = await fetchWithAuth(`/api/admin/content/reports?${query.toString()}`);
  const data = (await res.json().catch(() => null)) as { reports?: ReportSummary[]; error?: string } | null;
  if (!res.ok || !data?.reports) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data.reports;
}
