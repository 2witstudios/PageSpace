"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { AlertCircle, RefreshCw } from "lucide-react";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";

interface CompactionSummary {
  totalCompactions7d: number;
  distinctConversationsCompacted: number;
  avgSummaryTokens: number;
  totalCompactionCostCents: number;
  compactionLogsSince24h: number;
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
  meta: { since24h: string; since7d: string };
}

function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(cents / 100);
}

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
  const [data, setData] = useState<CompactionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetchWithAuth("/api/admin/compaction");
      if (!response.ok) throw new Error(`Failed to fetch compaction data: ${response.status}`);
      const json = (await response.json()) as CompactionResponse;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96" />
          </CardHeader>
        </Card>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-32" />
              </CardHeader>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>Error loading compaction data: {error}</AlertDescription>
      </Alert>
    );
  }

  if (!data) return null;

  const { summary, recent, recentLogs } = data;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle>Context Compaction</CardTitle>
            <CardDescription>
              Monitor compaction health — summaries stored, token savings, and recent activity.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchData}
            disabled={loading}
            className="shrink-0"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardHeader>
      </Card>

      {/* Summary stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Compactions (7d)</CardDescription>
            <CardTitle className="text-3xl">{summary.totalCompactions7d}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Conversations compacted</CardDescription>
            <CardTitle className="text-3xl">{summary.distinctConversationsCompacted}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Avg summary tokens</CardDescription>
            <CardTitle className="text-3xl">{summary.avgSummaryTokens.toLocaleString()}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Compaction cost (24h runs)</CardDescription>
            <CardTitle className="text-3xl">{usd(summary.totalCompactionCostCents)}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              {summary.compactionLogsSince24h} runs in last 24h
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent compaction state */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Compaction State</CardTitle>
          <CardDescription>20 most recently compacted conversations</CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
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
                  {recent.map((row) => (
                    <TableRow key={`${row.conversationId}-${row.source}`}>
                      <TableCell className="font-mono text-xs">{shortId(row.conversationId)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{row.source}</Badge>
                      </TableCell>
                      <TableCell className="text-right">{row.summaryTokens.toLocaleString()}</TableCell>
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
          <CardTitle>Recent Compaction Runs (24h)</CardTitle>
          <CardDescription>Latest compaction usage log entries (source = 'compaction')</CardDescription>
        </CardHeader>
        <CardContent>
          {recentLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No compaction runs in the last 24h.</p>
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
                  {recentLogs.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">
                        {row.conversationId ? shortId(row.conversationId) : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{row.model}</TableCell>
                      <TableCell className="text-right">
                        {row.inputTokens?.toLocaleString() ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.outputTokens?.toLocaleString() ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">{usd(row.costCents)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.timestamp
                          ? new Date(row.timestamp).toLocaleTimeString()
                          : "—"}
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
  );
}
