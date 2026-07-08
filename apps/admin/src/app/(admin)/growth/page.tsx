"use client";

import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { format, parseISO } from "date-fns";
import { RefreshCw, Users, TrendingUp, Activity, CreditCard } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard, PageHeader, DataState } from "@/components/admin/kit";
import { useAdminQuery } from "@/hooks/use-admin-query";
import { num } from "@/lib/format";
import type { GrowthMetricsData } from "@/lib/monitoring";

const TIER_COLORS: Record<string, string> = {
  free: "#94a3b8",
  pro: "#3b82f6",
  founder: "#8b5cf6",
  business: "#10b981",
};

const TIER_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  founder: "Founder",
  business: "Business",
};

function fmtMonth(isoDate: string) {
  try { return format(parseISO(isoDate), "MMM yy"); } catch { return isoDate; }
}

function fmtDay(isoDate: string) {
  try { return format(parseISO(isoDate), "MMM d"); } catch { return isoDate; }
}

function fmtSignedPct(n: number | null) {
  if (n === null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function GrowthSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

export default function GrowthPage() {
  const { data, isLoading, isFetching, error, refetch } = useAdminQuery<{ data: GrowthMetricsData }>(
    "/api/monitoring/growth"
  );

  const metrics = data?.data ?? null;
  const s = metrics?.summary;

  const mauTrendData = (metrics?.mauTrend ?? []).map(r => ({
    ...r,
    label: fmtMonth(r.period),
  }));

  const dauTrendData = (metrics?.dauTrend ?? []).map(r => ({
    ...r,
    label: fmtDay(r.day),
  }));

  const tierData = metrics?.tierBreakdown ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Growth"
        description="MAU, signups, engagement, and tier breakdown"
        actions={
          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10"
            onClick={refetch}
            disabled={isFetching}
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        }
      />

      <DataState isLoading={isLoading} error={error} onRetry={refetch} hasData={!!data} skeleton={<GrowthSkeleton />}>
        {/* Hero stats */}
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <StatCard
              label="Total users"
              value={s ? num(s.totalUsers) : "—"}
              hint={s ? `${num(s.payingUsers)} paying (${s.payingUsersPct.toFixed(1)}%)` : undefined}
              icon={Users}
            />
            <StatCard
              label="MAU (rolling 30d)"
              value={s ? num(s.mau) : "—"}
              hint="Distinct users with session activity"
              icon={Activity}
            />
            <StatCard
              label="WAU (rolling 7d)"
              value={s ? num(s.wau) : "—"}
              hint={s ? `DAU (last 24h): ${num(s.dau)}` : undefined}
              icon={TrendingUp}
            />
            <StatCard
              label="DAU/MAU stickiness"
              value={s ? `${s.dauMauRatio.toFixed(1)}%` : "—"}
              hint="Target: >20%"
              icon={Activity}
            />
          </div>

          {/* Secondary stats */}
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
            <StatCard
              label="New signups (rolling 30d)"
              value={s ? num(s.newUsersThisMonth) : "—"}
              hint={s ? `Prior 30d: ${num(s.newUsersLastMonth)}` : undefined}
              icon={TrendingUp}
            />
            <StatCard
              label="Paying users"
              value={s ? num(s.payingUsers) : "—"}
              hint={s ? `${s.payingUsersPct.toFixed(1)}% conversion rate` : undefined}
              icon={CreditCard}
            />
            <StatCard
              label="Signup growth (30d vs prior 30d)"
              value={s ? fmtSignedPct(s.momGrowthPct) : "—"}
              tone={s?.momGrowthPct == null ? "default" : s.momGrowthPct >= 0 ? "positive" : "negative"}
              icon={TrendingUp}
            />
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* MAU Trend — takes 2 cols */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>MAU Trend</CardTitle>
                <CardDescription>Monthly active users vs new signups — last 12 months</CardDescription>
              </CardHeader>
              <CardContent>
                {mauTrendData.length === 0 ? (
                  <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                    No activity data yet
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={mauTrendData}>
                      <defs>
                        <linearGradient id="mauGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="signupGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} className="text-muted-foreground" />
                      <YAxis tick={{ fontSize: 12 }} className="text-muted-foreground" />
                      <Tooltip
                        contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                        labelStyle={{ color: "hsl(var(--foreground))" }}
                      />
                      <Legend />
                      <Area type="monotone" dataKey="mau" name="MAU" stroke="#3b82f6" fill="url(#mauGrad)" strokeWidth={2} dot={false} />
                      <Area type="monotone" dataKey="newUsers" name="New Signups" stroke="#10b981" fill="url(#signupGrad)" strokeWidth={2} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Tier Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle>Tier Breakdown</CardTitle>
                <CardDescription>All users by subscription tier</CardDescription>
              </CardHeader>
              <CardContent>
                {tierData.length === 0 ? (
                  <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">No data</div>
                ) : (
                  <div className="space-y-4">
                    <ResponsiveContainer width="100%" height={160}>
                      <PieChart>
                        <Pie
                          data={tierData}
                          dataKey="count"
                          nameKey="tier"
                          cx="50%"
                          cy="50%"
                          innerRadius={40}
                          outerRadius={70}
                        >
                          {tierData.map((entry) => (
                            <Cell key={entry.tier} fill={TIER_COLORS[entry.tier] ?? "#64748b"} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                          formatter={(value, name) => [num(Number(value ?? 0)), TIER_LABELS[String(name)] ?? String(name)]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="space-y-2">
                      {tierData.map((t) => (
                        <div key={t.tier} className="flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2">
                            <div className="h-3 w-3 rounded-full" style={{ background: TIER_COLORS[t.tier] ?? "#64748b" }} />
                            <span className="capitalize">{TIER_LABELS[t.tier] ?? t.tier}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{num(t.count)}</span>
                            <span className="text-muted-foreground">{t.pct.toFixed(1)}%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* DAU trend */}
          <Card>
            <CardHeader>
              <CardTitle>Daily Activity (rolling 30d)</CardTitle>
              <CardDescription>Daily active users vs new signups</CardDescription>
            </CardHeader>
            <CardContent>
              {dauTrendData.length === 0 ? (
                <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                  No activity data yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={dauTrendData} barGap={2}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" className="text-muted-foreground" />
                    <YAxis tick={{ fontSize: 11 }} className="text-muted-foreground" />
                    <Tooltip
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                      labelStyle={{ color: "hsl(var(--foreground))" }}
                    />
                    <Legend />
                    <Bar dataKey="dau" name="DAU" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="signups" name="New Signups" fill="#10b981" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* MAU table */}
          {mauTrendData.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Monthly Summary</CardTitle>
                <CardDescription>Active users and new signups per calendar month</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="py-2 pr-4 text-left">Month</th>
                        <th className="py-2 pr-4 text-right">MAU</th>
                        <th className="py-2 pr-4 text-right">New Signups</th>
                        <th className="py-2 text-right">MAU Growth</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...mauTrendData].reverse().map((row, i, arr) => {
                        const prev = arr[i + 1];
                        const mauGrowth = prev && prev.mau > 0
                          ? ((row.mau - prev.mau) / prev.mau) * 100
                          : null;
                        return (
                          <tr key={row.period} className="border-b last:border-0">
                            <td className="py-2 pr-4 font-medium">{row.label}</td>
                            <td className="py-2 pr-4 text-right">{num(row.mau)}</td>
                            <td className="py-2 pr-4 text-right">{num(row.newUsers)}</td>
                            <td className="py-2 text-right">
                              {mauGrowth !== null ? (
                                <span className={mauGrowth >= 0 ? "text-success" : "text-destructive"}>
                                  {fmtSignedPct(mauGrowth)}
                                </span>
                              ) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </DataState>
    </div>
  );
}
