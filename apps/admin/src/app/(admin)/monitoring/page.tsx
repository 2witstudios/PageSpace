"use client";

import { Suspense, useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw, Users, AlertTriangle, OctagonAlert } from 'lucide-react';
import { format } from 'date-fns';
import { StatCard, PageHeader, DataState } from '@/components/admin/kit';
import { useAdminQuery } from '@/hooks/use-admin-query';
import { useUrlTab } from '@/hooks/use-url-tab';
import { num } from '@/lib/format';
import type {
  SystemHealthData,
  UserActivityData,
  ErrorAnalyticsData,
} from '@/lib/monitoring';

// Component imports
import SystemHealthWidget from './components/SystemHealthWidget';
import UserActivityHeatmap from './components/UserActivityHeatmap';
import ErrorRateGraph from './components/ErrorRateGraph';

type DateRange = '24h' | '7d' | '30d';

const TABS = ['health', 'errors', 'activity'] as const;
type MonitoringTab = (typeof TABS)[number];
const DEFAULT_TAB: MonitoringTab = 'health';

interface MetricResponse<T> {
  data: T;
}

function WidgetSkeleton() {
  return <Skeleton className="h-72 w-full" />;
}

function MonitoringDashboard() {
  const [activeTab, setTab] = useUrlTab<MonitoringTab>(TABS, DEFAULT_TAB);

  const [dateRange, setDateRange] = useState<DateRange>('24h');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refreshInterval = autoRefresh ? 30_000 : undefined;

  // Only the query backing the visible tab fetches and polls. system-health
  // stays always-on because the top StatCards row consumes it on every tab.
  const health = useAdminQuery<MetricResponse<SystemHealthData>>(
    `/api/monitoring/system-health?range=${dateRange}`,
    { refreshInterval },
  );
  const activity = useAdminQuery<MetricResponse<UserActivityData>>(
    `/api/monitoring/user-activity?range=${dateRange}`,
    { refreshInterval, enabled: activeTab === 'activity' },
  );
  const errors = useAdminQuery<MetricResponse<ErrorAnalyticsData>>(
    `/api/monitoring/error-logs?range=${dateRange}`,
    { refreshInterval, enabled: activeTab === 'errors' },
  );

  useEffect(() => {
    if (health.data || activity.data || errors.data) setLastUpdated(new Date());
  }, [health.data, activity.data, errors.data]);

  const isFetching = health.isFetching || activity.isFetching || errors.isFetching;

  const refetchAll = () => {
    health.refetch();
    activity.refetch();
    errors.refetch();
  };

  const healthData = health.data?.data ?? null;
  const errorCount = healthData?.logsByLevel?.find((l) => l.level === 'error')?.count ?? null;
  const warnCount = healthData?.logsByLevel?.find((l) => l.level === 'warn')?.count ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="System Monitoring"
        description={lastUpdated ? `Last updated: ${format(lastUpdated, 'PPpp')}` : 'Loading...'}
        actions={
          <>
            <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
              <SelectTrigger className="h-10 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="24h">Last 24h</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant={autoRefresh ? 'default' : 'outline'}
              size="icon"
              className="h-10 w-10"
              onClick={() => setAutoRefresh(!autoRefresh)}
              title={autoRefresh ? 'Auto-refresh ON (30s)' : 'Auto-refresh OFF'}
            >
              <RefreshCw className={`h-4 w-4 ${autoRefresh ? 'animate-spin' : ''}`} />
            </Button>

            <Button
              variant="outline"
              size="icon"
              className="h-10 w-10"
              onClick={refetchAll}
              disabled={isFetching}
              title="Refresh now"
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </>
        }
      />

      {/* Quick Stats */}
      <DataState
        isLoading={health.isLoading}
        error={health.error}
        onRetry={health.refetch}
        hasData={!!health.data}
        skeleton={
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          <StatCard
            label="Active users (15m)"
            value={healthData ? num(healthData.activeUserCount) : '—'}
            icon={Users}
          />
          <StatCard
            label={`Errors (${dateRange})`}
            value={errorCount != null ? num(errorCount) : '—'}
            tone={errorCount != null && errorCount > 0 ? 'negative' : 'default'}
            icon={OctagonAlert}
          />
          <StatCard
            label={`Warnings (${dateRange})`}
            value={warnCount != null ? num(warnCount) : '—'}
            tone={warnCount != null && warnCount > 0 ? 'warning' : 'default'}
            icon={AlertTriangle}
          />
        </div>
      </DataState>

      {/* Main Dashboard Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setTab(v as MonitoringTab)} className="space-y-4">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="health">Health</TabsTrigger>
          <TabsTrigger value="errors">Errors</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="health" className="space-y-4">
          <DataState
            isLoading={health.isLoading}
            error={health.error}
            onRetry={health.refetch}
            hasData={!!health.data}
            skeleton={<WidgetSkeleton />}
          >
            {healthData && <SystemHealthWidget data={healthData} />}
          </DataState>
        </TabsContent>

        <TabsContent value="errors" className="space-y-4">
          <DataState
            isLoading={errors.isLoading}
            error={errors.error}
            onRetry={errors.refetch}
            hasData={!!errors.data}
            skeleton={<WidgetSkeleton />}
          >
            {errors.data && <ErrorRateGraph data={errors.data.data} detailed />}
          </DataState>
        </TabsContent>

        <TabsContent value="activity" className="space-y-4">
          <DataState
            isLoading={activity.isLoading}
            error={activity.error}
            onRetry={activity.refetch}
            hasData={!!activity.data}
            skeleton={<WidgetSkeleton />}
          >
            {activity.data && <UserActivityHeatmap data={activity.data.data} />}
          </DataState>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function MonitoringPage() {
  return (
    <Suspense fallback={null}>
      <MonitoringDashboard />
    </Suspense>
  );
}
