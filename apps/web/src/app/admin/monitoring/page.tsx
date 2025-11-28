"use client";

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { RefreshCw, Download, DollarSign, Users, AlertTriangle } from 'lucide-react';
import { format } from 'date-fns';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type {
  SystemHealthData,
  UserActivityData,
  AiUsageData,
  ErrorAnalyticsData
} from '@/lib/monitoring/monitoring-types';

// Component imports
import SystemHealthWidget from './components/SystemHealthWidget';
import UserActivityHeatmap from './components/UserActivityHeatmap';
import AiUsageBreakdown from './components/AiUsageBreakdown';
import ErrorRateGraph from './components/ErrorRateGraph';

export default function MonitoringDashboard() {
  const [dateRange, setDateRange] = useState<'24h' | '7d' | '30d'>('24h');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  
  // Data states
  const [systemHealth, setSystemHealth] = useState<SystemHealthData | null>(null);
  const [userActivity, setUserActivity] = useState<UserActivityData | null>(null);
  const [aiUsage, setAiUsage] = useState<AiUsageData | null>(null);
  const [errorLogs, setErrorLogs] = useState<ErrorAnalyticsData | null>(null);

  // Fetch all metrics
  const fetchAllMetrics = useCallback(async () => {
    setIsLoading(true);
    try {
      const [health, users, ai, errors] = await Promise.all([
        fetchWithAuth(`/api/monitoring/system-health?range=${dateRange}`).then(r => r.json()),
        fetchWithAuth(`/api/monitoring/user-activity?range=${dateRange}`).then(r => r.json()),
        fetchWithAuth(`/api/monitoring/ai-usage?range=${dateRange}`).then(r => r.json()),
        fetchWithAuth(`/api/monitoring/error-logs?range=${dateRange}`).then(r => r.json()),
      ]);

      setSystemHealth(health.data);
      setUserActivity(users.data);
      setAiUsage(ai.data);
      setErrorLogs(errors.data);
      setLastUpdated(new Date());
    } catch (error) {
      console.error('Failed to fetch monitoring data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [dateRange]);

  // Initial load and refresh
  useEffect(() => {
    fetchAllMetrics();
  }, [fetchAllMetrics]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;
    
    const interval = setInterval(fetchAllMetrics, 30000); // 30 seconds
    return () => clearInterval(interval);
  }, [autoRefresh, fetchAllMetrics]);

  // Set initial timestamp on client mount to avoid hydration mismatch
  useEffect(() => {
    setLastUpdated(new Date());
  }, []);

  // Export data
  const exportData = () => {
    const data = {
      timestamp: new Date().toISOString(),
      dateRange,
      systemHealth,
      userActivity,
      aiUsage,
      errorLogs,
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `monitoring-export-${format(new Date(), 'yyyy-MM-dd-HH-mm')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header Controls */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">System Monitoring</h1>
          <p className="text-muted-foreground mt-1">
            Last updated: {lastUpdated ? format(lastUpdated, 'PPpp') : 'Loading...'}
          </p>
        </div>
        
        <div className="flex gap-2">
          <Select value={dateRange} onValueChange={(v) => setDateRange(v as '24h' | '7d' | '30d')}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">Last 24h</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
            </SelectContent>
          </Select>
          
          <Button
            variant={autoRefresh ? "default" : "outline"}
            size="icon"
            onClick={() => setAutoRefresh(!autoRefresh)}
            title={autoRefresh ? "Auto-refresh ON" : "Auto-refresh OFF"}
          >
            <RefreshCw className={`h-4 w-4 ${autoRefresh ? 'animate-spin' : ''}`} />
          </Button>
          
          <Button
            variant="outline"
            size="icon"
            onClick={fetchAllMetrics}
            disabled={isLoading}
            title="Refresh now"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
          
          <Button
            variant="outline"
            size="icon"
            onClick={exportData}
            title="Export data"
          >
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{systemHealth?.activeUserCount || 0}</div>
            <p className="text-xs text-muted-foreground">Last 15 minutes</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">AI Usage Cost</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${aiUsage?.costsByProvider?.reduce((sum, p) => sum + (p.totalCost || 0), 0).toFixed(2) || '0.00'}
            </div>
            <p className="text-xs text-muted-foreground">
              Success rate: {aiUsage?.successRate?.toFixed(1) || 0}%
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">System Errors</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {systemHealth?.logsByLevel?.find((l) => l.level === 'error')?.count || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              Warnings: {systemHealth?.logsByLevel?.find((l) => l.level === 'warn')?.count || 0}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Dashboard Tabs */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="ai">AI Usage</TabsTrigger>
          <TabsTrigger value="errors">Errors</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SystemHealthWidget data={systemHealth} isLoading={isLoading} />
            <AiUsageBreakdown data={aiUsage} isLoading={isLoading} />
          </div>
          <ErrorRateGraph data={errorLogs} isLoading={isLoading} />
        </TabsContent>

        <TabsContent value="users" className="space-y-4">
          <UserActivityHeatmap data={userActivity} isLoading={isLoading} />
        </TabsContent>

        <TabsContent value="ai" className="space-y-4">
          <AiUsageBreakdown data={aiUsage} isLoading={isLoading} detailed />
        </TabsContent>

        <TabsContent value="errors" className="space-y-4">
          <ErrorRateGraph data={errorLogs} isLoading={isLoading} detailed />
        </TabsContent>
      </Tabs>
    </div>
  );
}