'use client';

import { useEffect, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { OrgAuditCategory } from '@pagespace/lib/audit/org-audit-query-core';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useOrgAdminRead } from '@/hooks/useOrgs';
import { OrgBadge } from '@/components/orgs/OrgBadge';
import { OrgSettingsShell, type OrgSettingsContext } from '@/components/orgs/OrgSettingsShell';
import { ApiRequestError, fetchJSON, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { orgKeys, type OrgDriveDirectoryEntry } from '@/lib/orgs/org-api';
import { AUDIT_CATEGORY_LABELS, auditQueryString, auditSentence, type AuditFilters } from '@/lib/orgs/org-audit';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';

interface AuditEntry {
  timestamp: string;
  category: OrgAuditCategory;
  eventType: string;
  actorId: string | null;
  actorName: string | null;
  resourceType: string | null;
  resourceId: string | null;
  driveId: string | null;
  details: Record<string, unknown>;
}

const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];

const initials = (name: string | null) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

function AuditBody({ orgId, role }: OrgSettingsContext) {
  const [filters, setFiltersState] = useState<AuditFilters>({ category: 'all', driveId: 'any', days: 30 });
  // The look-back is anchored when the filters change, so the SWR key is stable between renders.
  const [now, setNow] = useState(() => Date.now());
  const setFilters = (update: (f: AuditFilters) => AuditFilters) => {
    setFiltersState(update);
    setNow(Date.now());
  };
  const [more, setMore] = useState<AuditEntry[]>([]);
  // undefined until a later page loads: the first page's cursor comes from the read itself.
  const [moreCursor, setMoreCursor] = useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const query = auditQueryString(filters, now);
  const key = `/api/orgs/${orgId}/audit${query ? `?${query}` : ''}`;
  const read = useOrgAdminRead<{ entries: AuditEntry[]; nextCursor: number | null }>(key, role);
  const drives = useOrgAdminRead<{ drives: OrgDriveDirectoryEntry[] }>(orgKeys.drives(orgId), role).data?.drives;
  const driveName = new Map((drives ?? []).map((d) => [d.id, d.name]));

  useEffect(() => {
    setMore([]);
    setMoreCursor(undefined);
  }, [key]);
  const cursor = moreCursor === undefined ? (read.data?.nextCursor ?? null) : moreCursor;

  const entries = [...(read.data?.entries ?? []), ...more];

  const loadMore = async () => {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const page = await fetchJSON<{ entries: AuditEntry[]; nextCursor: number | null }>(`/api/orgs/${orgId}/audit?${auditQueryString({ ...filters, before: cursor }, now)}`);
      setMore((prev) => [...prev, ...page.entries]);
      setMoreCursor(page.nextCursor);
    } catch (error) {
      toast.error(orgErrorMessage(error, 'More entries could not be loaded.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await fetchWithAuth(`/api/orgs/${orgId}/audit/export${query ? `?${query}` : ''}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(orgErrorMessage(new ApiRequestError('export refused', res.status, body), 'The export could not be made. Try again later.'));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `org-audit-${new Date(now).toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-2">
          <Select value={filters.category} onValueChange={(v) => setFilters((f) => ({ ...f, category: v as AuditFilters['category'] }))}>
            <SelectTrigger aria-label="Event type" className="h-8 w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {(Object.keys(AUDIT_CATEGORY_LABELS) as OrgAuditCategory[]).map((c) => (
                <SelectItem key={c} value={c}>{AUDIT_CATEGORY_LABELS[c]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.driveId} onValueChange={(v) => setFilters((f) => ({ ...f, driveId: v }))}>
            <SelectTrigger aria-label="Drive" className="h-8 w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any drive</SelectItem>
              {(drives ?? []).map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.days === null ? 'all' : String(filters.days)} onValueChange={(v) => setFilters((f) => ({ ...f, days: v === 'all' ? null : Number(v) }))}>
            <SelectTrigger aria-label="Time" className="h-8 w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" variant="outline" onClick={() => void exportCsv()} disabled={exporting}>
          {exporting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
          Export CSV
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        {read.isLoading ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">No events match these filters.</div>
        ) : (
          entries.map((e, i) => {
            const drive = e.driveId ? driveName.get(e.driveId) : undefined;
            return (
              <div key={`${e.timestamp}-${e.eventType}-${i}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-3 first:border-t-0 md:flex-nowrap">
                <Avatar className="h-6 w-6"><AvatarFallback className="text-[10px]">{initials(e.actorName)}</AvatarFallback></Avatar>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm">
                    <span className="font-medium">{e.actorName ?? 'PageSpace'}</span> {auditSentence(e.eventType)}
                    {drive ? <> · <b>{drive}</b></> : null}
                  </span>
                  <span className="text-[13px] text-muted-foreground">{AUDIT_CATEGORY_LABELS[e.category] ?? e.category}</span>
                </div>
                <OrgBadge tone="outline">{AUDIT_CATEGORY_LABELS[e.category] ?? e.category}</OrgBadge>
                <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">{formatDistanceToNowStrict(Date.parse(e.timestamp))} ago</span>
              </div>
            );
          })
        )}
      </div>
      {cursor !== null ? (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}

export default function OrgAuditPage() {
  return (
    <OrgSettingsShell
      title="Audit log"
      description={(orgName) => `Membership, policy, billing, and admin actions across ${orgName}. Page edits stay in each drive’s Activity.`}
    >
      {(ctx) => <AuditBody {...ctx} />}
    </OrgSettingsShell>
  );
}
