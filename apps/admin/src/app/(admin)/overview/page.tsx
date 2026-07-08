'use client';

import Link from 'next/link';
import { Activity, AlertTriangle, CreditCard, LifeBuoy, TrendingUp, UserPlus, Users } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StatCard, PageHeader, DataState } from '@/components/admin/kit';
import { useAdminQuery } from '@/hooks/use-admin-query';
import { usd, pct, num } from '@/lib/format';
// Type-only import: erased at compile time, so no server code enters the bundle.
import type { OverviewSummary } from '@/app/api/admin/overview/route';

interface AlertsResponse {
  errorRateAlert: boolean;
  negativeMarginAlert: boolean;
  liveHoldsAlert: boolean;
  errorRate: number;
  negativeMarginCount: number;
  liveHoldsCount: number;
}

export default function OverviewPage() {
  const summary = useAdminQuery<OverviewSummary>('/api/admin/overview', { refreshInterval: 60_000 });
  const alerts = useAdminQuery<AlertsResponse>('/api/admin/alerts', { refreshInterval: 60_000 });

  const activeAlerts = alerts.data
    ? [
        alerts.data.errorRateAlert && {
          key: 'errors',
          text: `API error rate is ${alerts.data.errorRate.toFixed(1)}% over the last 24h`,
          href: '/monitoring',
          cta: 'Open Monitoring',
        },
        alerts.data.negativeMarginAlert && {
          key: 'margin',
          text: `${alerts.data.negativeMarginCount} account(s) running at negative margin`,
          href: '/billing',
          cta: 'Open Billing',
        },
        alerts.data.liveHoldsAlert && {
          key: 'holds',
          text: `${alerts.data.liveHoldsCount} live credit holds outstanding`,
          href: '/billing',
          cta: 'Open Billing',
        },
      ].filter((a): a is { key: string; text: string; href: string; cta: string } => Boolean(a))
    : [];

  const s = summary.data;
  const marginTone = s?.marginPct == null ? 'default' : s.marginPct < 0 ? 'negative' : 'positive';

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description="Platform health at a glance. Sections in the sidebar drill into each area." />

      {activeAlerts.map((alert) => (
        <Alert key={alert.key} variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Needs attention</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{alert.text}</span>
            <Button asChild variant="outline" size="sm">
              <Link href={alert.href}>{alert.cta}</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ))}

      <DataState isLoading={summary.isLoading} error={summary.error} onRetry={summary.refetch} hasData={!!s}>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <StatCard label="Total users" value={s ? num(s.totalUsers) : '—'} icon={Users} />
          <StatCard label="New users (7d)" value={s ? num(s.newUsers7d) : '—'} icon={UserPlus} />
          <StatCard label="Active now (15m)" value={s ? num(s.activeUsers15m) : '—'} icon={Activity} />
          <StatCard label="Paying subscribers" value={s ? num(s.payingSubscribers) : '—'} icon={CreditCard} hint="Active + trialing, excludes gifted" />
          <StatCard
            label="API error rate (24h)"
            value={s ? pct(s.errorRate24h) : '—'}
            tone={s && s.errorRate24h > 5 ? 'negative' : 'default'}
          />
          <StatCard label="AI cost (30d)" value={s ? usd(s.realCostCents) : '—'} hint="Actual provider cost" />
          <StatCard label="AI charged (30d)" value={s ? usd(s.chargedCents) : '—'} hint="Credits charged to users" />
          <StatCard
            label="AI margin (30d)"
            value={s ? pct(s.marginPct) : '—'}
            tone={marginTone}
            icon={TrendingUp}
          />
        </div>

        {s !== null && s.openSupport > 0 && (
          <div className="mt-4">
            <StatCard
              label="Open support requests"
              value={num(s.openSupport)}
              icon={LifeBuoy}
              tone="warning"
              hint={<Link className="underline" href="/support">Go to Support</Link>}
            />
          </div>
        )}
      </DataState>
    </div>
  );
}
