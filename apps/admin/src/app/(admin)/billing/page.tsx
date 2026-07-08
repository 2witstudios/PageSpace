'use client';

import { Suspense, useCallback, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Banknote, Coins, Download, HandCoins, Scale, ShieldAlert, ShieldCheck, TrendingUp } from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { StatCard, PageHeader, DataState } from '@/components/admin/kit';
import { useAdminQuery } from '@/hooks/use-admin-query';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { usd, pct, num } from '@/lib/format';

type Range = '24h' | '7d' | '30d' | 'all';
type Granularity = 'day' | 'month';
type Coverage = 'real' | 'estimate' | 'list_price';

const TABS = ['overview', 'margins', 'users', 'enforcement'] as const;
type TabKey = (typeof TABS)[number];

function isTabKey(value: string | null): value is TabKey {
  return TABS.includes(value as TabKey);
}

interface Summary {
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
  debtCents: number;
  marginCents: number;
  marginPct: number | null;
}

interface MarginPeriodRow {
  period: string;
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
  marginCents: number;
  marginPct: number | null;
}

interface MarginModelRow {
  provider: string;
  model: string;
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
  marginCents: number;
  marginPct: number | null;
}

interface MarginTierRow {
  tier: string;
  realCostCents: number;
  chargedCents: number;
  requestCount: number;
  marginCents: number;
  marginPct: number | null;
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

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
}

interface TokenModelRow extends TokenTotals { provider: string; model: string; }
interface TokenPeriodRow extends TokenTotals { period: string; }
interface TokenUserRow extends TokenTotals { userId: string; userName: string | null; userEmail: string | null; }

interface SubscriptionTierRow { tier: string; count: number; }

interface Enforcement {
  enabled: boolean;
  markupBps: number;
  tierAllowanceCents: Record<string, number>;
}

interface BillingResponse {
  range: Range;
  granularity: Granularity;
  enforcement: Enforcement;
  summary: Summary;
  marginByPeriod: MarginPeriodRow[];
  marginByModel: MarginModelRow[];
  marginByTier: MarginTierRow[];
  providerCost: ProviderCostRow[];
  topSpenders: SpenderRow[];
  debtByUser: DebtRow[];
  revenue: { topupCents: number; monthlyGrantCents: number };
  subscriptionsByTier: SubscriptionTierRow[];
  liability: { monthlyRemainingCents: number; topupRemainingCents: number; totalLiabilityCents: number; userCount: number };
  holds: { holdCount: number; heldCents: number };
  alerts: { balanceDrift: BalanceDriftRow[]; negativeMargin: NegativeMarginRow[] };
  tokens: { summary: TokenTotals; byModel: TokenModelRow[]; byPeriod: TokenPeriodRow[]; byUser: TokenUserRow[] };
}

function marginClass(value: number | null): string {
  if (value === null) return 'text-muted-foreground';
  return value < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400';
}

function userLabel(row: { userName: string | null; userEmail: string | null; userId: string }): string {
  return row.userEmail ?? row.userName ?? row.userId;
}

function formatPeriodLabel(period: string, granularity: Granularity): string {
  const datePart = String(period).slice(0, 10);
  return granularity === 'month' ? datePart.slice(0, 7) : datePart;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function OverviewTab({ data }: { data: BillingResponse }) {
  const { summary, revenue, liability, holds, tokens, subscriptionsByTier } = data;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Top-up revenue" value={usd(revenue.topupCents)} icon={Banknote} hint="Real cash from Stripe top-ups in range" />
        <StatCard label="Allowance grants" value={usd(revenue.monthlyGrantCents)} icon={HandCoins} hint="Monthly credit grants in range — not cash revenue" />
        <StatCard label="Provider cost (what we paid)" value={usd(summary.realCostCents)} icon={Coins} />
        <StatCard label="Charged to users (credits)" value={usd(summary.chargedCents)} hint={`Credits applied: ${usd(summary.appliedCents)}`} />
        <StatCard
          label="Gross margin"
          value={`${usd(summary.marginCents)} (${pct(summary.marginPct)})`}
          icon={TrendingUp}
          tone={summary.marginPct === null ? 'default' : summary.marginPct < 0 ? 'negative' : 'positive'}
        />
        <StatCard
          label="Outstanding liability"
          value={usd(liability.totalLiabilityCents)}
          icon={Scale}
          hint={`Monthly ${usd(liability.monthlyRemainingCents)} · Top-up ${usd(liability.topupRemainingCents)} · ${num(liability.userCount)} users`}
        />
        <StatCard label="Live holds" value={usd(holds.heldCents)} hint={`${num(holds.holdCount)} open holds`} />
        <StatCard
          label="Outstanding debt (all-time)"
          value={usd(summary.debtCents)}
          tone={summary.debtCents > 0 ? 'negative' : 'default'}
          hint="Point-in-time, not range-scoped"
        />
        <StatCard label="Requests" value={num(summary.requestCount)} hint="Billed AI requests in range" />
        <StatCard
          label="Total tokens"
          value={num(tokens.summary.totalTokens)}
          hint={`In ${num(tokens.summary.inputTokens)} · Out ${num(tokens.summary.outputTokens)}`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Paying subscribers by tier (active + trialing, excludes gifted)</CardTitle>
          <CardDescription>Point-in-time subscription counts.</CardDescription>
        </CardHeader>
        <CardContent>
          {subscriptionsByTier.length === 0 ? (
            <EmptyNote>No paying subscribers.</EmptyNote>
          ) : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Tier</TableHead><TableHead className="text-right">Subscribers</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {subscriptionsByTier.map((row) => (
                  <TableRow key={row.tier}>
                    <TableCell className="capitalize">{row.tier}</TableCell>
                    <TableCell className="text-right">{num(row.count)}</TableCell>
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

function MarginsTab({ data }: { data: BillingResponse }) {
  const { granularity, marginByPeriod, marginByModel, marginByTier, providerCost, tokens } = data;
  const periodNoun = granularity === 'month' ? 'month' : 'day';
  return (
    <div className="space-y-6">
      {marginByPeriod.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Margin trend</CardTitle>
            <CardDescription>Provider cost (what we paid) vs charged to users (credits) per {periodNoun} — gap is your gross margin.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="min-w-0 overflow-hidden">
              <ResponsiveContainer width="100%" height={240}>
                <LineChart
                  data={[...marginByPeriod]
                    .sort((a, b) => (String(a.period) < String(b.period) ? -1 : 1))
                    .map((r) => ({
                      period: String(r.period).slice(0, granularity === 'month' ? 7 : 10),
                      realCost: +(r.realCostCents / 100).toFixed(2),
                      charged: +(r.chargedCents / 100).toFixed(2),
                      margin: +(r.marginCents / 100).toFixed(2),
                    }))}
                  margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v) => [`$${Number(v ?? 0).toFixed(2)}`]} />
                  <Legend />
                  <Line type="monotone" dataKey="charged" name="Charged" stroke="#2563eb" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="realCost" name="Provider cost" stroke="#dc2626" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="margin" name="Margin" stroke="#16a34a" strokeWidth={2} dot={false} strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Margin over time</CardTitle>
          <CardDescription>Provider cost vs charged credits per {periodNoun}.</CardDescription>
        </CardHeader>
        <CardContent>
          {marginByPeriod.length === 0 ? (
            <EmptyNote>No billed AI usage in this range.</EmptyNote>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Provider cost</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-right">Margin %</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {marginByPeriod.map((row) => (
                  <TableRow key={row.period}>
                    <TableCell className="font-mono text-xs">{formatPeriodLabel(row.period, granularity)}</TableCell>
                    <TableCell className="text-right">{usd(row.realCostCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.chargedCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{usd(row.marginCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{pct(row.marginPct)}</TableCell>
                    <TableCell className="text-right">{num(row.requestCount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Margin by model</CardTitle>
          <CardDescription>Which providers and models earn or lose money.</CardDescription>
        </CardHeader>
        <CardContent>
          {marginByModel.length === 0 ? (
            <EmptyNote>No billed AI usage in this range.</EmptyNote>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Provider cost</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-right">Margin %</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {marginByModel.map((row) => (
                  <TableRow key={`${row.provider}/${row.model}`}>
                    <TableCell>{row.provider}</TableCell>
                    <TableCell className="font-mono text-xs">{row.model}</TableCell>
                    <TableCell className="text-right">{usd(row.realCostCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.chargedCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{usd(row.marginCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{pct(row.marginPct)}</TableCell>
                    <TableCell className="text-right">{num(row.requestCount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Provider cost by billing basis</CardTitle>
          <CardDescription>
            What we pay providers per model, split by billing basis. <Badge variant="outline">real</Badge> = OpenRouter&apos;s returned cost;{' '}
            <Badge variant="secondary">estimate</Badge> = static fallback; <Badge variant="default">list_price</Badge> = voice billed at exact
            quantity × OpenAI&apos;s published rate.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {providerCost.length === 0 ? (
            <EmptyNote>No billed AI usage in this range.</EmptyNote>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Basis</TableHead>
                  <TableHead className="text-right">Provider cost</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-right">Margin %</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providerCost.map((row) => (
                  <TableRow key={`${row.provider}/${row.model}/${row.coverage}`}>
                    <TableCell>{row.provider}</TableCell>
                    <TableCell className="font-mono text-xs">{row.model}</TableCell>
                    <TableCell>
                      <Badge variant={row.coverage === 'real' ? 'outline' : row.coverage === 'list_price' ? 'default' : 'secondary'}>{row.coverage}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{usd(row.realCostCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.chargedCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{usd(row.marginCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{pct(row.marginPct)}</TableCell>
                    <TableCell className="text-right">{num(row.requestCount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Margin by tier</CardTitle>
          <CardDescription>Cost and margin breakdown across subscription tiers.</CardDescription>
        </CardHeader>
        <CardContent>
          {marginByTier.length === 0 ? (
            <EmptyNote>No billed AI usage in this range.</EmptyNote>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Provider cost</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-right">Margin %</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {marginByTier.map((row) => (
                  <TableRow key={row.tier}>
                    <TableCell className="capitalize">{row.tier}</TableCell>
                    <TableCell className="text-right">{usd(row.realCostCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.chargedCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{usd(row.marginCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{pct(row.marginPct)}</TableCell>
                    <TableCell className="text-right">{num(row.requestCount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Token usage by model</CardTitle>
            <CardDescription>Input/output/total tokens per provider and model.</CardDescription>
          </CardHeader>
          <CardContent>
            {tokens.byModel.length === 0 ? (
              <EmptyNote>No AI usage in this range.</EmptyNote>
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
        <Card>
          <CardHeader>
            <CardTitle>Token usage over time</CardTitle>
            <CardDescription>Tokens per {periodNoun}.</CardDescription>
          </CardHeader>
          <CardContent>
            {tokens.byPeriod.length === 0 ? (
              <EmptyNote>No AI usage in this range.</EmptyNote>
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
                      <TableCell className="font-mono text-xs">{formatPeriodLabel(row.period, granularity)}</TableCell>
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
    </div>
  );
}

function UsersTab({ data }: { data: BillingResponse }) {
  const { topSpenders, debtByUser, alerts, tokens } = data;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Top spenders</CardTitle>
          <CardDescription>Users by charged credits, with our provider cost and margin.</CardDescription>
        </CardHeader>
        <CardContent>
          {topSpenders.length === 0 ? (
            <EmptyNote>No billed AI usage in this range.</EmptyNote>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Provider cost</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-right">Margin %</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topSpenders.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell className="max-w-[260px] truncate">{userLabel(row)}</TableCell>
                    <TableCell className="text-right">{usd(row.chargedCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.realCostCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{usd(row.marginCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{pct(row.marginPct)}</TableCell>
                    <TableCell className="text-right">{num(row.requestCount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400" />
            Negative margin ({alerts.negativeMargin.length})
          </CardTitle>
          <CardDescription>Accounts where provider cost exceeds what we charged.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Provider cost</TableHead>
                <TableHead className="text-right">Charged</TableHead>
                <TableHead className="text-right">Margin</TableHead>
                <TableHead className="text-right">Margin %</TableHead>
                <TableHead className="text-right">Requests</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {alerts.negativeMargin.length > 0 ? (
                alerts.negativeMargin.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell className="max-w-[260px] truncate">{userLabel(row)}</TableCell>
                    <TableCell className="text-right">{usd(row.realCostCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.chargedCents)}</TableCell>
                    <TableCell className={`text-right font-medium ${marginClass(row.marginCents)}`}>{usd(row.marginCents)}</TableCell>
                    <TableCell className={`text-right ${marginClass(row.marginPct)}`}>{pct(row.marginPct)}</TableCell>
                    <TableCell className="text-right">{num(row.requestCount)}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="py-4 text-center text-sm text-muted-foreground">No negative-margin accounts</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Balance drift ({alerts.balanceDrift.length})</CardTitle>
          <CardDescription>Accounts where the materialized balance disagrees with the ledger.</CardDescription>
        </CardHeader>
        <CardContent>
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
              {alerts.balanceDrift.length > 0 ? (
                alerts.balanceDrift.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell className="max-w-[260px] truncate">{userLabel(row)}</TableCell>
                    <TableCell className="text-right">{usd(row.expectedSpendableCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.materializedSpendableCents)}</TableCell>
                    <TableCell className="text-right font-medium text-red-600 dark:text-red-400">{usd(row.driftCents)}</TableCell>
                    <TableCell className="text-right">{usd(row.debtCents)}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="py-4 text-center text-sm text-muted-foreground">No balance drift detected</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Outstanding debt (all-time)</CardTitle>
            <CardDescription>Uncovered AI cost we couldn&apos;t collect, by user. Point-in-time, not range-scoped.</CardDescription>
          </CardHeader>
          <CardContent>
            {debtByUser.length === 0 ? (
              <EmptyNote>No outstanding debt.</EmptyNote>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow><TableHead>User</TableHead><TableHead className="text-right">Debt</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {debtByUser.map((row) => (
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
          <CardHeader>
            <CardTitle>Token usage by user</CardTitle>
            <CardDescription>Heaviest users by total tokens.</CardDescription>
          </CardHeader>
          <CardContent>
            {tokens.byUser.length === 0 ? (
              <EmptyNote>No AI usage in this range.</EmptyNote>
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
      </div>
    </div>
  );
}

function EnforcementTab({ data }: { data: BillingResponse }) {
  const { enforcement } = data;
  const markupMultiplier = (enforcement.markupBps / 10000).toFixed(2);
  return (
    <div className="space-y-6">
      <Alert variant={enforcement.enabled ? 'destructive' : 'default'}>
        {enforcement.enabled ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
        <AlertDescription>
          <span className="font-semibold">Credit enforcement is {enforcement.enabled ? 'ON' : 'OFF (dark-launch)'}.</span>{' '}
          {enforcement.enabled
            ? 'Out-of-credits and over-in-flight-cap requests are being denied (402/429).'
            : 'Usage is metered and billed, but no request is denied.'}
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Markup on provider cost" value={`${markupMultiplier}×`} hint={`${num(enforcement.markupBps)} bps`} />
        <StatCard label="Enforcement" value={enforcement.enabled ? 'ON' : 'OFF'} tone={enforcement.enabled ? 'positive' : 'warning'} hint={enforcement.enabled ? 'Denying over-limit requests' : 'Dark-launch: metered, never denied'} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Monthly credit allowance by tier</CardTitle>
          <CardDescription>Credits granted on each subscription renewal.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Tier</TableHead><TableHead className="text-right">Monthly allowance</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(enforcement.tierAllowanceCents).map(([tier, cents]) => (
                <TableRow key={tier}>
                  <TableCell className="capitalize">{tier}</TableCell>
                  <TableCell className="text-right">{usd(cents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function BillingPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: TabKey = isTabKey(tabParam) ? tabParam : 'overview';

  const [range, setRange] = useState<Range>('30d');
  const [granularity, setGranularity] = useState<Granularity>('day');

  const query = useAdminQuery<BillingResponse>(`/api/admin/billing?range=${range}&granularity=${granularity}`);
  const { data } = query;

  const setTab = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'overview') params.delete('tab');
      else params.set('tab', next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const downloadCsv = useCallback(async () => {
    const params = new URLSearchParams({ range, granularity, format: 'csv' });
    const response = await fetchWithAuth(`/api/admin/billing?${params.toString()}`);
    if (!response.ok) return;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `billing-${range}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [range, granularity]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        description="AI unit economics, credit revenue vs allowance, liability, and enforcement. All figures in USD."
        actions={
          <>
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
            <Button variant="outline" size="sm" onClick={downloadCsv} className="gap-2 self-end">
              <Download className="h-4 w-4" />Export CSV
            </Button>
            {query.isFetching && !query.isLoading && <span className="self-end text-sm text-muted-foreground">Refreshing…</span>}
          </>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="margins">Margins</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="enforcement">Enforcement</TabsTrigger>
        </TabsList>

        <div className="mt-4">
          <DataState isLoading={query.isLoading} error={query.error} onRetry={query.refetch}>
            {data && (
              <>
                <TabsContent value="overview"><OverviewTab data={data} /></TabsContent>
                <TabsContent value="margins"><MarginsTab data={data} /></TabsContent>
                <TabsContent value="users"><UsersTab data={data} /></TabsContent>
                <TabsContent value="enforcement"><EnforcementTab data={data} /></TabsContent>
              </>
            )}
          </DataState>
        </div>
      </Tabs>
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={null}>
      <BillingPageInner />
    </Suspense>
  );
}
