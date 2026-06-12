"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertCircle, Download, TrendingUp } from "lucide-react";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";

type Range = "24h" | "7d" | "30d" | "all";
type Granularity = "day" | "month";

interface Summary {
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
  debtCents: number;
  marginCents: number;
  marginPct: number | null;
}

interface PeriodRow {
  period: string;
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
  marginCents: number;
  marginPct: number | null;
}

interface ModelRow {
  provider: string;
  model: string;
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
  marginCents: number;
  marginPct: number | null;
}

interface SpenderRow {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
  marginCents: number;
  marginPct: number | null;
}

interface DebtRow {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  debtCents: number;
}

interface TierRow {
  tier: string;
  realCostCents: number;
  chargedCents: number;
  requestCount: number;
  marginCents: number;
  marginPct: number | null;
}

interface UnitEconomicsResponse {
  range: Range;
  granularity: Granularity;
  summary: Summary;
  byPeriod: PeriodRow[];
  byModel: ModelRow[];
  byTier: TierRow[];
  topSpenders: SpenderRow[];
  debtByUser: DebtRow[];
}

function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function formatPeriodLabel(period: string, granularity: Granularity): string {
  const datePart = String(period).slice(0, 10);
  return granularity === "month" ? datePart.slice(0, 7) : datePart;
}

function pct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function marginClass(value: number | null): string {
  if (value === null) return "text-muted-foreground";
  if (value < 0) return "text-red-600 dark:text-red-400";
  return "text-green-600 dark:text-green-400";
}

function userLabel(row: { userName: string | null; userEmail: string | null; userId: string }): string {
  return row.userEmail ?? row.userName ?? row.userId;
}

export default function AdminUnitEconomicsPage() {
  const [data, setData] = useState<UnitEconomicsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("30d");
  const [granularity, setGranularity] = useState<Granularity>("day");

  const fetchData = useCallback(async (r: Range, g: Granularity) => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ range: r, granularity: g });
      const response = await fetchWithAuth(`/api/admin/unit-economics?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch unit-economics data");
      const json = (await response.json()) as UnitEconomicsResponse;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(range, granularity); }, [fetchData, range, granularity]);

  const downloadCsv = useCallback(async () => {
    const params = new URLSearchParams({ range, granularity, format: "csv" });
    const response = await fetchWithAuth(`/api/admin/unit-economics?${params.toString()}`);
    if (!response.ok) return;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `unit-economics-${range}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [range, granularity]);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Card><CardHeader><Skeleton className="h-8 w-64" /><Skeleton className="h-4 w-96" /></CardHeader></Card>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}><CardHeader><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-32" /></CardHeader></Card>
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>Error loading unit economics: {error}</AlertDescription></Alert>;
  }

  if (!data) {
    return <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>No data received</AlertDescription></Alert>;
  }

  const { summary } = data;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5" />AI Unit Economics</CardTitle>
          <CardDescription>Real provider cost vs charged credits and gross margin, per period, model, and user. All figures are in USD.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Range</Label>
              <Select value={range} onValueChange={(v) => setRange(v as Range)}>
                <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="24h">Last 24 hours</SelectItem>
                  <SelectItem value="7d">Last 7 days</SelectItem>
                  <SelectItem value="30d">Last 30 days</SelectItem>
                  <SelectItem value="all">All time</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Granularity</Label>
              <Select value={granularity} onValueChange={(v) => setGranularity(v as Granularity)}>
                <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Daily</SelectItem>
                  <SelectItem value="month">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" size="sm" onClick={downloadCsv} className="gap-2">
              <Download className="h-4 w-4" />Export CSV
            </Button>
            {loading && <span className="text-sm text-muted-foreground">Loading…</span>}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card><CardHeader className="pb-2"><CardDescription>Real cost</CardDescription><CardTitle className="text-2xl">{usd(summary.realCostCents)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Charged credits</CardDescription><CardTitle className="text-2xl">{usd(summary.chargedCents)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Gross margin</CardDescription><CardTitle className={`text-2xl ${marginClass(summary.marginPct)}`}>{usd(summary.marginCents)}<span className="ml-2 text-base">({pct(summary.marginPct)})</span></CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Outstanding debt</CardDescription><CardTitle className="text-2xl">{usd(summary.debtCents)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Requests</CardDescription><CardTitle className="text-2xl">{summary.requestCount.toLocaleString()}</CardTitle></CardHeader></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Margin by model</CardTitle><CardDescription>Which providers and models earn or lose money.</CardDescription></CardHeader>
        <CardContent>
          {data.byModel.length === 0 ? (
            <p className="text-sm text-muted-foreground">No billed AI usage in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead><TableHead>Model</TableHead>
                  <TableHead className="text-right">Real cost</TableHead><TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Margin</TableHead><TableHead className="text-right">Margin %</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byModel.map((row) => (
                  <TableRow key={`${row.provider}/${row.model}`}>
                    <TableCell>{row.provider}</TableCell>
                    <TableCell className="font-mono text-xs">{row.model}</TableCell>
                    <TableCell className="text-right">{usd(row.realCostCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.chargedCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{usd(row.marginCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{pct(row.marginPct)}</TableCell>
                    <TableCell className="text-right">{row.requestCount.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Top spenders</CardTitle><CardDescription>Users by charged credits, with our real cost and margin.</CardDescription></CardHeader>
        <CardContent>
          {data.topSpenders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No billed AI usage in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead><TableHead className="text-right">Real cost</TableHead>
                  <TableHead className="text-right">Charged</TableHead><TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-right">Margin %</TableHead><TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topSpenders.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell className="max-w-[260px] truncate">{userLabel(row)}</TableCell>
                    <TableCell className="text-right">{usd(row.realCostCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.chargedCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{usd(row.marginCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{pct(row.marginPct)}</TableCell>
                    <TableCell className="text-right">{row.requestCount.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Margin by tier</CardTitle><CardDescription>Cost and margin breakdown across subscription tiers.</CardDescription></CardHeader>
        <CardContent>
          {data.byTier.length === 0 ? (
            <p className="text-sm text-muted-foreground">No billed AI usage in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Real cost</TableHead><TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Margin</TableHead><TableHead className="text-right">Margin %</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byTier.map((row) => (
                  <TableRow key={row.tier}>
                    <TableCell className="capitalize">{row.tier}</TableCell>
                    <TableCell className="text-right">{usd(row.realCostCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.chargedCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{usd(row.marginCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{pct(row.marginPct)}</TableCell>
                    <TableCell className="text-right">{row.requestCount.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Outstanding debt</CardTitle><CardDescription>Uncovered AI cost we couldn&apos;t collect, by user.</CardDescription></CardHeader>
        <CardContent>
          {data.debtByUser.length === 0 ? (
            <p className="text-sm text-muted-foreground">No outstanding debt.</p>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>User</TableHead><TableHead className="text-right">Debt</TableHead></TableRow></TableHeader>
              <TableBody>
                {data.debtByUser.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell className="max-w-[260px] truncate">{userLabel(row)}</TableCell>
                    <TableCell className="text-right text-red-600 dark:text-red-400">{usd(row.debtCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Margin over time</CardTitle><CardDescription>Real cost vs charged credits per {granularity === "month" ? "month" : "day"}.</CardDescription></CardHeader>
        <CardContent>
          {data.byPeriod.length === 0 ? (
            <p className="text-sm text-muted-foreground">No billed AI usage in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead><TableHead className="text-right">Real cost</TableHead>
                  <TableHead className="text-right">Charged</TableHead><TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-right">Margin %</TableHead><TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byPeriod.map((row) => (
                  <TableRow key={row.period}>
                    <TableCell className="font-mono text-xs">{formatPeriodLabel(row.period, data.granularity)}</TableCell>
                    <TableCell className="text-right">{usd(row.realCostCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.chargedCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{usd(row.marginCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{pct(row.marginPct)}</TableCell>
                    <TableCell className="text-right">{row.requestCount.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
