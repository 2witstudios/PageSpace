"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefreshCw } from "lucide-react";
import { StatCard, PageHeader, DataState } from "@/components/admin/kit";
import { useAdminQuery } from "@/hooks/use-admin-query";
import { usd, num } from "@/lib/format";

interface CompactionSummary {
  windowDays: number;
  totalCompactions7d: number;
  distinctConversationsCompacted7d: number;
  avgSummaryTokens7d: number;
  totalCompactionCostCents7d: number;
}

interface CompactionRow {
  conversationId: string;
  source: string;
  summaryTokens: number;
  summaryVersion: number;
  summarizerModel: string | null;
  lastCompactedAt: string | null;
  ageMinutes: number | null;
}

interface CompactionLogRow {
  conversationId: string | null;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costCents: number;
  timestamp: string | null;
}

interface CompactionResponse {
  summary: CompactionSummary;
  recent: CompactionRow[];
  recentLogs: CompactionLogRow[];
  meta: { since7d: string; recentStateLimit: number; recentLogsLimit: number };
}

const STAT_LABELS = [
  "Compaction runs (7d)",
  "Conversations compacted (7d)",
  "Avg summary tokens (7d)",
  "Compaction cost (7d)",
] as const;

function shortId(id: string): string {
  return id.slice(0, 8) + "…";
}

function ageLabel(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes}m ago`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function AdminCompactionPage() {
  const { data, isLoading, isFetching, error, refetch } =
    useAdminQuery<CompactionResponse>("/api/admin/compaction");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Context Compaction"
        description="Compaction health — all summary stats cover the trailing 7-day window."
        actions={
          <Button variant="outline" size="sm" onClick={refetch} disabled={isFetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      <DataState
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        skeleton={
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {STAT_LABELS.map((label) => (
                <StatCard key={label} label={label} value="" isLoading />
              ))}
            </div>
            <Skeleton className="h-64 w-full" />
          </div>
        }
      >
        {data && (
          <div className="space-y-6">
            {/* Summary stats — one consistent 7-day window */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Compaction runs (7d)"
                value={num(data.summary.totalCompactions7d)}
                hint="LLM summarization runs in the last 7 days"
              />
              <StatCard
                label="Conversations compacted (7d)"
                value={num(data.summary.distinctConversationsCompacted7d)}
                hint="Distinct conversations compacted in the last 7 days"
              />
              <StatCard
                label="Avg summary tokens (7d)"
                value={num(data.summary.avgSummaryTokens7d)}
                hint="Across conversations compacted in the last 7 days"
              />
              <StatCard
                label="Compaction cost (7d)"
                value={usd(data.summary.totalCompactionCostCents7d)}
                hint="All runs in the last 7 days — no truncation"
              />
            </div>

            {/* Recent compaction state */}
            <Card>
              <CardHeader>
                <CardTitle>Recent Compaction State</CardTitle>
                <CardDescription>
                  {data.meta.recentStateLimit} most recently compacted conversations (all time)
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.recent.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No compaction rows found.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Conversation</TableHead>
                          <TableHead>Source</TableHead>
                          <TableHead className="text-right">Summary tokens</TableHead>
                          <TableHead className="text-right">Version</TableHead>
                          <TableHead>Model</TableHead>
                          <TableHead>Last compacted</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.recent.map((row) => (
                          <TableRow key={`${row.conversationId}-${row.source}`}>
                            <TableCell className="font-mono text-xs">{shortId(row.conversationId)}</TableCell>
                            <TableCell>
                              <Badge variant="outline">{row.source}</Badge>
                            </TableCell>
                            <TableCell className="text-right">{num(row.summaryTokens)}</TableCell>
                            <TableCell className="text-right">{row.summaryVersion}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {row.summarizerModel ?? "—"}
                            </TableCell>
                            <TableCell className="text-sm">{ageLabel(row.ageMinutes)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Recent compaction usage log */}
            <Card>
              <CardHeader>
                <CardTitle>Recent Compaction Runs (7d)</CardTitle>
                <CardDescription>
                  Latest {data.meta.recentLogsLimit} usage-log entries (source = &apos;compaction&apos;)
                  from the last 7 days — display only; summary stats above aggregate the full window.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.recentLogs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No compaction runs in the last 7 days.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Conversation</TableHead>
                          <TableHead>Model</TableHead>
                          <TableHead className="text-right">Input tokens</TableHead>
                          <TableHead className="text-right">Output tokens</TableHead>
                          <TableHead className="text-right">Cost</TableHead>
                          <TableHead>Time</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.recentLogs.map((row, i) => (
                          <TableRow key={i}>
                            <TableCell className="font-mono text-xs">
                              {row.conversationId ? shortId(row.conversationId) : "—"}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">{row.model}</TableCell>
                            <TableCell className="text-right">
                              {row.inputTokens != null ? num(row.inputTokens) : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {row.outputTokens != null ? num(row.outputTokens) : "—"}
                            </TableCell>
                            <TableCell className="text-right">{usd(row.costCents)}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {row.timestamp ? new Date(row.timestamp).toLocaleString() : "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </DataState>
    </div>
  );
}
