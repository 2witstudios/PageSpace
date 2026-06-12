"use client";

import { useState, useEffect, useCallback } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
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

function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  badge,
  isLoading,
}: {
  title: string;
  value: string | number;
  sub?: string;
  icon: typeof Users;
  badge?: { label: string; variant: "default" | "secondary" | "destructive" | "outline" };
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <>
            <div className="text-2xl font-bold">{value}</div>
            <div className="flex items-center gap-2 mt-1">
              {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
              {badge && <Badge variant={badge.variant} className="text-xs">{badge.label}</Badge>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function fmtMonth(isoDate: string) {
  try { return format(parseISO(isoDate), "MMM yy"); } catch { return isoDate; }
}

function fmtDay(isoDate: string) {
  try { return format(parseISO(isoDate), "MMM d"); } catch { return isoDate; }
}

function fmtPct(n: number | null) {
  if (n === null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

export default function GrowthPage() {
  const [data, setData] = useState<GrowthMetricsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetchWithAuth("/api/monitoring/growth");
      const json = await res.json();
      setData(json.data);
    } catch {
      // keep stale data visible
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const s = data?.summary;

  const momBadge = s?.momGrowthPct !== undefined && s.momGrowthPct !== null
    ? {
        label: fmtPct(s.momGrowthPct),
        variant: (s.momGrowthPct >= 0 ? "default" : "destructive") as "default" | "destructive",
      }
    : undefined;

  const mauTrendData = (data?.mauTrend ?? []).map(r => ({
    ...r,
    label: fmtMonth(r.period),
  }));

  const dauTrendData = (data?.dauTrend ?? []).map(r => ({
    ...r,
    label: fmtDay(r.day),
  }));

  const tierData = data?.tierBreakdown ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Growth</h1>
          <p className="text-muted-foreground mt-1">MAU, signups, engagement, and tier breakdown</p>
        </div>
        <Button variant="outline" size="icon" onClick={fetchData} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Hero stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Total Users"
          value={s?.totalUsers.toLocaleString() ?? "—"}
          sub={`${s?.payingUsers ?? 0} paying (${s?.payingUsersPct.toFixed(1) ?? 0}%)`}
          icon={Users}
          isLoading={isLoading}
        />
        <StatCard
          title="MAU (30d)"
          value={s?.mau.toLocaleString() ?? "—"}
          sub="Distinct users with session activity"
          icon={Activity}
          isLoading={isLoading}
        />
        <StatCard
          title="WAU (7d)"
          value={s?.wau.toLocaleString() ?? "—"}
          sub={`DAU: ${s?.dau ?? 0}`}
          icon={TrendingUp}
          isLoading={isLoading}
        />
        <StatCard
          title="DAU/MAU Stickiness"
          value={s ? `${s.dauMauRatio.toFixed(1)}%` : "—"}
          sub="Target: >20%"
          icon={Activity}
          isLoading={isLoading}
        />
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard
          title="New (Last 30d)"
          value={s?.newUsersThisMonth.toLocaleString() ?? "—"}
          sub={`Prior 30d: ${s?.newUsersLastMonth ?? 0}`}
          icon={TrendingUp}
          badge={momBadge}
          isLoading={isLoading}
        />
        <StatCard
          title="Paying Users"
          value={s?.payingUsers.toLocaleString() ?? "—"}
          sub={`${s?.payingUsersPct.toFixed(1) ?? 0}% conversion rate`}
          icon={CreditCard}
          isLoading={isLoading}
        />
        <StatCard
          title="30d Signup Growth"
          value={s ? fmtPct(s.momGrowthPct) : "—"}
          sub="Last 30d vs prior 30d"
          icon={TrendingUp}
          isLoading={isLoading}
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* MAU Trend — takes 2 cols */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>MAU Trend</CardTitle>
            <CardDescription>Monthly active users vs new signups — last 12 months</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : mauTrendData.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
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
            {isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : tierData.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">No data</div>
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
                      formatter={(value, name) => [Number(value ?? 0).toLocaleString(), TIER_LABELS[String(name)] ?? String(name)]}
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
                        <span className="font-medium">{t.count.toLocaleString()}</span>
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
          <CardTitle>Daily Activity (Last 30 Days)</CardTitle>
          <CardDescription>Daily active users vs new signups</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : dauTrendData.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
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
            <CardDescription>Active users and new signups per month</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2 pr-4">Month</th>
                    <th className="text-right py-2 pr-4">MAU</th>
                    <th className="text-right py-2 pr-4">New Signups</th>
                    <th className="text-right py-2">MAU Growth</th>
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
                        <td className="py-2 pr-4 text-right">{row.mau.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-right">{row.newUsers.toLocaleString()}</td>
                        <td className="py-2 text-right">
                          {mauGrowth !== null ? (
                            <span className={mauGrowth >= 0 ? "text-emerald-500" : "text-red-500"}>
                              {fmtPct(mauGrowth)}
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
  );
}
