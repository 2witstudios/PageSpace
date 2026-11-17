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
import type { ReviewTarget } from "@/components/admin/content/report-queue";
import { LinkedCaseReports, ReportsTab } from "@/components/admin/content/reports-tab";
import { TargetPanel } from "@/components/admin/content/target-panel";
import { useAdminQuery } from "@/hooks/use-admin-query";
import { useUrlTab } from "@/hooks/use-url-tab";
import type { CaseSummary } from "@/lib/content/case-summary";

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

function CasesTab({ caseId, onReview }: { caseId: string | null; onReview: (target: ReviewTarget) => void }) {
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
  // A reported case's target and the content hash its report named, handed to the Take down tab. The key
  // remounts the panel on them.
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget>({ targetId: "", reportedHash: null });
  const review = (target: ReviewTarget) => {
    setReviewTarget(target);
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
          <TargetPanel
            key={`${reviewTarget.targetId}:${reviewTarget.reportedHash ?? ""}`}
            initialQuery={reviewTarget.targetId}
            reportedHash={reviewTarget.reportedHash}
          />
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
