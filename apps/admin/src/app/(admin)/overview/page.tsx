'use client';

import Link from 'next/link';
import { Activity, AlertTriangle, CreditCard, LifeBuoy, TrendingUp, UserPlus, Users } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StatCard, PageHeader, DataState } from '@/components/admin/kit';
import { useAdminQuery } from '@/hooks/use-admin-query';

interface OverviewSummary {
  totalUsers: number;
  newUsers7d: number;
  activeUsers15m: number;
  payingSubscribers: number;
  errorRate24h: number;
  openSupport: number;
  realCostCents: number;
  chargedCents: number;
  marginPct: number | null;
}

interface AlertsResponse {
  errorRateAlert: boolean;
  negativeMarginAlert: boolean;
  liveHoldsAlert: boolean;
  errorRate: number;
  negativeMarginCount: number;
  liveHoldsCount: number;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

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

      <DataState isLoading={summary.isLoading} error={summary.error} onRetry={summary.refetch}>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <StatCard label="Total users" value={s?.totalUsers.toLocaleString() ?? '—'} icon={Users} />
          <StatCard label="New users (7d)" value={s?.newUsers7d.toLocaleString() ?? '—'} icon={UserPlus} />
          <StatCard label="Active now (15m)" value={s?.activeUsers15m.toLocaleString() ?? '—'} icon={Activity} />
          <StatCard label="Paying subscribers" value={s?.payingSubscribers.toLocaleString() ?? '—'} icon={CreditCard} hint="Active + trialing, excludes gifted" />
          <StatCard
            label="API error rate (24h)"
            value={s ? `${s.errorRate24h.toFixed(1)}%` : '—'}
            tone={s && s.errorRate24h > 5 ? 'negative' : 'default'}
          />
          <StatCard label="AI cost (30d)" value={s ? usd(s.realCostCents) : '—'} hint="Actual provider cost" />
          <StatCard label="AI charged (30d)" value={s ? usd(s.chargedCents) : '—'} hint="Credits charged to users" />
          <StatCard
            label="AI margin (30d)"
            value={s?.marginPct == null ? 'n/a' : `${s.marginPct.toFixed(1)}%`}
            tone={marginTone}
            icon={TrendingUp}
          />
        </div>

        {s !== null && s.openSupport > 0 && (
          <div className="mt-4">
            <StatCard
              label="Open support requests"
              value={s.openSupport.toLocaleString()}
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
