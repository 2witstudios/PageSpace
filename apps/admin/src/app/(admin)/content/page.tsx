"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataState, PageHeader } from "@/components/admin/kit";
import { BlockedUploads } from "@/components/admin/content/blocked-uploads";
import { CaseList } from "@/components/admin/content/case-list";
import { ReportQueue } from "@/components/admin/content/report-queue";
import { TargetPanel } from "@/components/admin/content/target-panel";
import { useAdminQuery } from "@/hooks/use-admin-query";
import { useUrlTab } from "@/hooks/use-url-tab";
import type { CaseSummary } from "@/lib/content/case-summary";
import type { ReportedCaseSummary } from "@/lib/content/report-summary";

const TABS = ["reports", "takedown", "cases", "blocked"] as const;
type Tab = (typeof TABS)[number];

const STATUS_FILTERS = [
  { value: "all", label: "All cases" },
  { value: "reported", label: "Reported, needs review" },
  { value: "open", label: "Open (stopped part-way)" },
  { value: "awaiting_evidence", label: "Awaiting evidence storage" },
  { value: "actioned", label: "Actioned" },
  { value: "dismissed", label: "Dismissed" },
] as const;

/** Reports waiting for review. "Review and act" opens the Take down tab on the case's target. */
function ReportsTab({ onReview }: { onReview: (targetId: string) => void }) {
  const { data, isLoading, isFetching, error, refetch } = useAdminQuery<{ cases: ReportedCaseSummary[] }>(
    "/api/admin/content/reports?limit=100",
  );
  const items = data?.cases ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          A report never takes anything down by itself. Review the target, act from Take down, then close the report.
        </p>
        <Button variant="outline" size="sm" onClick={refetch} disabled={isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>
      <DataState
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        hasData={!!data}
        isEmpty={!!data && items.length === 0}
        emptyMessage="No reports waiting for review."
      >
        <ReportQueue items={items} onChanged={refetch} onReview={onReview} />
      </DataState>
    </div>
  );
}

/** The reports on one linked case, if it has any (an alert about a report links here). */
function LinkedCaseReports({ caseId, onReview }: { caseId: string; onReview: (targetId: string) => void }) {
  const { data, refetch } = useAdminQuery<{ cases: ReportedCaseSummary[] }>(
    `/api/admin/content/reports?id=${encodeURIComponent(caseId)}`,
  );
  const items = (data?.cases ?? []).filter((item) => item.reportCount > 0);
  if (items.length === 0) return null;
  return <ReportQueue items={items} onChanged={refetch} onReview={onReview} />;
}

function CasesTab({ caseId, onReview }: { caseId: string | null; onReview: (targetId: string) => void }) {
  const [status, setStatus] = useState<string>("all");
  const url = useMemo(() => {
    // An alert email links to one case: show just that one.
    if (caseId) return `/api/admin/content/cases?id=${encodeURIComponent(caseId)}`;
    return `/api/admin/content/cases?status=${status}&limit=100`;
  }, [caseId, status]);
  const { data, isLoading, isFetching, error, refetch } = useAdminQuery<{ cases: CaseSummary[] }>(url);
  const cases = data?.cases ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {!caseId && (
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((filter) => (
                <SelectItem key={filter.value} value={filter.value}>{filter.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button variant="outline" size="sm" onClick={refetch} disabled={isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <DataState
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        hasData={!!data}
        isEmpty={!!data && cases.length === 0}
        emptyMessage="No cases."
      >
        <CaseList cases={cases} onChanged={refetch} />
      </DataState>

      {caseId && <LinkedCaseReports caseId={caseId} onReview={onReview} />}
    </div>
  );
}

function ContentSafety() {
  const searchParams = useSearchParams();
  const caseId = searchParams.get("case");
  // A link to a case opens on the Cases tab.
  const [tab, setTab] = useUrlTab<Tab>(TABS, caseId ? "cases" : "reports");
  // A reported case's target, handed to the Take down tab. The key remounts the panel on it.
  const [reviewTarget, setReviewTarget] = useState("");
  const review = (targetId: string) => {
    setReviewTarget(targetId);
    setTab("takedown");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content Safety"
        description="Review reports, take down illegal or violating content, follow cases, and see attempts to re-upload blocked files. Metadata only: files are never displayed."
      />

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          <TabsTrigger value="takedown">Take down</TabsTrigger>
          <TabsTrigger value="cases">Cases</TabsTrigger>
          <TabsTrigger value="blocked">Blocked uploads</TabsTrigger>
        </TabsList>
        <TabsContent value="reports" className="mt-4">
          <ReportsTab onReview={review} />
        </TabsContent>
        <TabsContent value="takedown" className="mt-4">
          <TargetPanel key={reviewTarget} initialQuery={reviewTarget} />
        </TabsContent>
        <TabsContent value="cases" className="mt-4">
          <CasesTab caseId={caseId} onReview={review} />
        </TabsContent>
        <TabsContent value="blocked" className="mt-4">
          <BlockedUploads />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function AdminContentSafetyPage() {
  return (
    <Suspense fallback={null}>
      <ContentSafety />
    </Suspense>
  );
}
