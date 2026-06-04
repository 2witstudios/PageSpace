"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { AlertCircle, Download, Receipt, ShieldAlert, ShieldCheck } from "lucide-react";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";

type Range = "24h" | "7d" | "30d" | "all";
type Granularity = "day" | "month";
type Coverage = "real" | "estimate" | "list_price";
type Tier = "free" | "pro" | "founder" | "business";

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
}

interface TokenModelRow extends TokenTotals {
  provider: string;
  model: string;
}

interface TokenPeriodRow extends TokenTotals {
  period: string;
}

interface TokenUserRow extends TokenTotals {
  userId: string;
  userName: string | null;
  userEmail: string | null;
}

interface ProviderCostRow {
  provider: string;
  model: string;
  coverage: Coverage;
  realCostCents: number;
  chargedCents: number;
  marginCents: number;
  marginPct: number | null;
  requestCount: number;
}

interface SubscriptionTierRow {
  tier: Tier;
  count: number;
}

interface BalanceDriftRow {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  expectedSpendableCents: number;
  materializedSpendableCents: number;
  driftCents: number;
  debtCents: number;
}

interface NegativeMarginRow {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  realCostCents: number;
  chargedCents: number;
  marginCents: number;
  marginPct: number | null;
  requestCount: number;
}

interface Enforcement {
  enabled: boolean;
  markupBps: number;
  tierAllowanceCents: Record<Tier, number>;
}

interface AiBillingResponse {
  range: Range;
  granularity: Granularity;
  enforcement: Enforcement;
  tokens: {
    summary: TokenTotals;
    byModel: TokenModelRow[];
    byPeriod: TokenPeriodRow[];
    byUser: TokenUserRow[];
  };
  providerCost: ProviderCostRow[];
  revenue: {
    topupCents: number;
    topupCount: number;
    monthlyGrantCents: number;
    monthlyGrantCount: number;
    totalCents: number;
    subscriptionsByTier: SubscriptionTierRow[];
  };
  liability: {
    monthlyRemainingCents: number;
    topupRemainingCents: number;
    totalLiabilityCents: number;
    userCount: number;
  };
  holds: {
    holdCount: number;
    heldCents: number;
  };
  alerts: {
    balanceDrift: BalanceDriftRow[];
    negativeMargin: NegativeMarginRow[];
  };
}

const TIERS: Tier[] = ["free", "pro", "founder", "business"];

function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function num(value: number): string {
  return value.toLocaleString();
}

/**
 * Label a period bucket from the server's DATE_TRUNC timestamp string directly.
 * Never reparse through `new Date(...)`: that shifts plain YYYY-MM-DD buckets for
 * clients west of UTC and turns a monthly bucket into an arbitrary day.
 */
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

export default function AdminAiBillingPage() {
  const [data, setData] = useState<AiBillingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("30d");
  const [granularity, setGranularity] = useState<Granularity>("day");
  // Monotonic request token: when the user flips range/granularity quickly, an
  // older in-flight fetch can resolve after a newer one. We only commit a
  // response if it's still the latest request, so stale data can't clobber the
  // current selection.
  const latestRequest = useRef(0);

  const fetchData = useCallback(async (r: Range, g: Granularity) => {
    const reqId = ++latestRequest.current;
    try {
      setLoading(true);
      const params = new URLSearchParams({ range: r, granularity: g });
      const response = await fetchWithAuth(`/api/admin/ai-billing?${params.toString()}`);
      if (!response.ok) {
        throw new Error("Failed to fetch AI billing data");
      }
      const json = (await response.json()) as AiBillingResponse;
      if (reqId !== latestRequest.current) return; // superseded by a newer request
      setData(json);
      setError(null);
    } catch (err) {
      if (reqId !== latestRequest.current) return;
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      if (reqId === latestRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(range, granularity);
  }, [fetchData, range, granularity]);

  const downloadCsv = useCallback(async () => {
    const params = new URLSearchParams({ range, granularity, format: "csv" });
    const response = await fetchWithAuth(`/api/admin/ai-billing?${params.toString()}`);
    if (!response.ok) return;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ai-billing-${range}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [range, granularity]);

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
        <AlertDescription>Error loading AI billing: {error}</AlertDescription>
      </Alert>
    );
  }

  if (!data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>No data received</AlertDescription>
      </Alert>
    );
  }

  const { enforcement, tokens, revenue, liability, holds, alerts } = data;
  const markupMultiplier = (enforcement.markupBps / 10000).toFixed(2);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            AI Billing
          </CardTitle>
          <CardDescription>
            Token volume, provider cost (real vs estimated), Stripe credit revenue, and
            outstanding liability. Watch real numbers here before enabling enforcement.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Range</Label>
              <Select value={range} onValueChange={(v) => setRange(v as Range)}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
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
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Daily</SelectItem>
                  <SelectItem value="month">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" size="sm" onClick={downloadCsv} className="gap-2">
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
            {loading && <span className="text-sm text-muted-foreground">Loading…</span>}
          </div>
        </CardContent>
      </Card>

      {/* Enforcement status banner */}
      <Alert variant={enforcement.enabled ? "destructive" : "default"}>
        {enforcement.enabled ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
        <AlertDescription>
          <span className="font-semibold">
            Credit enforcement is {enforcement.enabled ? "ON" : "OFF (dark-launch)"}.
          </span>{" "}
          {enforcement.enabled
            ? "Out-of-credits and over-in-flight-cap requests are being denied (402/429)."
            : "Usage is metered and billed, but no request is denied. Markup "}
          {!enforcement.enabled && <span className="font-mono">{markupMultiplier}×</span>}
          {!enforcement.enabled && (
            <>
              . Monthly allowance:{" "}
              {TIERS.map((t, i) => (
                <span key={t}>
                  {i > 0 ? ", " : ""}
                  {t} {usd(enforcement.tierAllowanceCents[t])}
                </span>
              ))}
              .
            </>
          )}
        </AlertDescription>
      </Alert>

      {/* Account-level alerts: balance drift + negative margin */}
      {(alerts.balanceDrift.length > 0 || alerts.negativeMargin.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400" />
              Account alerts
            </CardTitle>
            <CardDescription>
              Accounts to review: balance drift (materialized buckets diverge from the
              ledger — a smell detector; resets/forgiveness make it approximate) and
              negative margin (charged credits don&apos;t cover real provider cost).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {alerts.balanceDrift.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold">Balance drift ({alerts.balanceDrift.length})</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead className="text-right">Expected</TableHead>
                      <TableHead className="text-right">Materialized</TableHead>
                      <TableHead className="text-right">Drift</TableHead>
                      <TableHead className="text-right">Debt</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {alerts.balanceDrift.map((r) => (
                      <TableRow key={r.userId}>
                        <TableCell>{userLabel(r)}</TableCell>
                        <TableCell className="text-right">{usd(r.expectedSpendableCents)}</TableCell>
                        <TableCell className="text-right">{usd(r.materializedSpendableCents)}</TableCell>
                        <TableCell className={`text-right font-medium ${marginClass(-Math.abs(r.driftCents) || 0)}`}>
                          {usd(r.driftCents)}
                        </TableCell>
                        <TableCell className="text-right">{usd(r.debtCents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {alerts.negativeMargin.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold">Negative margin ({alerts.negativeMargin.length})</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead className="text-right">Real cost</TableHead>
                      <TableHead className="text-right">Charged</TableHead>
                      <TableHead className="text-right">Margin</TableHead>
                      <TableHead className="text-right">Margin %</TableHead>
                      <TableHead className="text-right">Requests</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {alerts.negativeMargin.map((r) => (
                      <TableRow key={r.userId}>
                        <TableCell>{userLabel(r)}</TableCell>
                        <TableCell className="text-right">{usd(r.realCostCents)}</TableCell>
                        <TableCell className="text-right">{usd(r.chargedCents)}</TableCell>
                        <TableCell className={`text-right font-medium ${marginClass(r.marginCents)}`}>
                          {usd(r.marginCents)}
                        </TableCell>
                        <TableCell className={`text-right ${marginClass(r.marginPct)}`}>{pct(r.marginPct)}</TableCell>
                        <TableCell className="text-right">{num(r.requestCount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total tokens</CardDescription>
            <CardTitle className="text-2xl">{num(tokens.summary.totalTokens)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Requests</CardDescription>
            <CardTitle className="text-2xl">{num(tokens.summary.requestCount)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Credit revenue</CardDescription>
            <CardTitle className="text-2xl">{usd(revenue.totalCents)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Outstanding liability</CardDescription>
            <CardTitle className="text-2xl">{usd(liability.totalLiabilityCents)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Live holds</CardDescription>
            <CardTitle className="text-2xl">
              {usd(holds.heldCents)}
              <span className="ml-2 text-base text-muted-foreground">({num(holds.holdCount)})</span>
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Provider cost rollup */}
      <Card>
        <CardHeader>
          <CardTitle>Provider cost</CardTitle>
          <CardDescription>
            What we pay providers per model, split by billing basis. <Badge variant="outline">real</Badge> =
            OpenRouter&apos;s returned cost; <Badge variant="secondary">estimate</Badge> = static fallback
            (direct providers, or an OpenRouter call whose cost metadata was missing);{" "}
            <Badge variant="default">list_price</Badge> = voice (STT/TTS) billed at exact
            quantity × OpenAI&apos;s published rate.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.providerCost.length === 0 ? (
            <p className="text-sm text-muted-foreground">No billed AI usage in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Basis</TableHead>
                  <TableHead className="text-right">Real cost</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-right">Margin %</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.providerCost.map((row) => (
                  // coverage is part of the key: a provider/model can now appear
                  // as both a 'real' and an 'estimate' row.
                  <TableRow key={`${row.provider}/${row.model}/${row.coverage}`}>
                    <TableCell>{row.provider}</TableCell>
                    <TableCell className="font-mono text-xs">{row.model}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          row.coverage === "real"
                            ? "outline"
                            : row.coverage === "list_price"
                              ? "default"
                              : "secondary"
                        }
                      >
                        {row.coverage}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{usd(row.realCostCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.chargedCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>
                      {usd(row.marginCents)}
                    </TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>
                      {pct(row.marginPct)}
                    </TableCell>
                    <TableCell className="text-right">{num(row.requestCount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Stripe revenue */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Credit revenue</CardTitle>
            <CardDescription>Stripe-sourced credit funding in this range.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Top-up purchases</TableCell>
                  <TableCell className="text-right">{num(revenue.topupCount)}</TableCell>
                  <TableCell className="text-right">{usd(revenue.topupCents)}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Monthly grants</TableCell>
                  <TableCell className="text-right">{num(revenue.monthlyGrantCount)}</TableCell>
                  <TableCell className="text-right">{usd(revenue.monthlyGrantCents)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Active subscriptions</CardTitle>
            <CardDescription>Live subscriptions by tier (point-in-time).</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Subscribers</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {revenue.subscriptionsByTier.map((row) => (
                  <TableRow key={row.tier}>
                    <TableCell className="capitalize">{row.tier}</TableCell>
                    <TableCell className="text-right">{num(row.count)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Token usage by model */}
      <Card>
        <CardHeader>
          <CardTitle>Token usage by model</CardTitle>
          <CardDescription>Input/output/total tokens per provider and model.</CardDescription>
        </CardHeader>
        <CardContent>
          {tokens.byModel.length === 0 ? (
            <p className="text-sm text-muted-foreground">No AI usage in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.byModel.map((row) => (
                  <TableRow key={`${row.provider}/${row.model}`}>
                    <TableCell>{row.provider}</TableCell>
                    <TableCell className="font-mono text-xs">{row.model}</TableCell>
                    <TableCell className="text-right">{num(row.inputTokens)}</TableCell>
                    <TableCell className="text-right">{num(row.outputTokens)}</TableCell>
                    <TableCell className="text-right">{num(row.totalTokens)}</TableCell>
                    <TableCell className="text-right">{num(row.requestCount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Token usage by user */}
      <Card>
        <CardHeader>
          <CardTitle>Token usage by user</CardTitle>
          <CardDescription>Heaviest users by total tokens.</CardDescription>
        </CardHeader>
        <CardContent>
          {tokens.byUser.length === 0 ? (
            <p className="text-sm text-muted-foreground">No AI usage in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.byUser.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell className="max-w-[260px] truncate">{userLabel(row)}</TableCell>
                    <TableCell className="text-right">{num(row.inputTokens)}</TableCell>
                    <TableCell className="text-right">{num(row.outputTokens)}</TableCell>
                    <TableCell className="text-right">{num(row.totalTokens)}</TableCell>
                    <TableCell className="text-right">{num(row.requestCount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Token usage over time */}
      <Card>
        <CardHeader>
          <CardTitle>Token usage over time</CardTitle>
          <CardDescription>Tokens per {granularity === "month" ? "month" : "day"}.</CardDescription>
        </CardHeader>
        <CardContent>
          {tokens.byPeriod.length === 0 ? (
            <p className="text-sm text-muted-foreground">No AI usage in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.byPeriod.map((row) => (
                  <TableRow key={row.period}>
                    <TableCell className="font-mono text-xs">
                      {formatPeriodLabel(row.period, data.granularity)}
                    </TableCell>
                    <TableCell className="text-right">{num(row.inputTokens)}</TableCell>
                    <TableCell className="text-right">{num(row.outputTokens)}</TableCell>
                    <TableCell className="text-right">{num(row.totalTokens)}</TableCell>
                    <TableCell className="text-right">{num(row.requestCount)}</TableCell>
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
