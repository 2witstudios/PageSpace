import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Clock, Zap, AlertTriangle } from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, 
  Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { format } from 'date-fns';
import type { PerformanceMetricsData, MonitoringWidgetProps } from '@/lib/monitoring-types';

type PerformanceMetricsProps = MonitoringWidgetProps<PerformanceMetricsData>;

export default function PerformanceMetrics({ data, isLoading }: PerformanceMetricsProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Performance Metrics</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-64 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Format response time data
  const responseTimeData = data?.responseTimes?.map((item) => ({
    time: format(new Date(item.hour), 'MMM dd HH:mm'),
    avg: parseFloat(item.avg_response_time) || 0,
    max: parseFloat(item.max_response_time) || 0,
    min: parseFloat(item.min_response_time) || 0,
  })).reverse() || [];

  // Calculate average response time
  const avgResponseTime = responseTimeData.length > 0
    ? responseTimeData.reduce((sum, item) => sum + item.avg, 0) / responseTimeData.length
    : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Response Time</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgResponseTime.toFixed(0)}ms</div>
            <p className="text-xs text-muted-foreground">
              Across all endpoints
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Slow Queries</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data?.slowQueries?.length || 0}</div>
            <p className="text-xs text-muted-foreground">
              Responses &gt; 5 seconds
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Metric Types</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data?.metricTypes?.length || 0}</div>
            <p className="text-xs text-muted-foreground">
              Performance indicators tracked
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Response Time Trends</CardTitle>
          <CardDescription>
            API response times over the selected period
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={responseTimeData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis 
                dataKey="time" 
                tick={{ fontSize: 12 }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Line 
                type="monotone" 
                dataKey="avg" 
                stroke="#8884d8" 
                name="Average"
                strokeWidth={2}
              />
              <Line 
                type="monotone" 
                dataKey="max" 
                stroke="#FF6B6B" 
                name="Maximum"
                strokeWidth={1}
                strokeDasharray="5 5"
              />
              <Line 
                type="monotone" 
                dataKey="min" 
                stroke="#82ca9d" 
                name="Minimum"
                strokeWidth={1}
                strokeDasharray="5 5"
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Slow Queries</CardTitle>
            <CardDescription>Requests taking more than 5 seconds</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64">
              <div className="space-y-2">
                {(data?.slowQueries?.length || 0) > 0 ? (
                  data?.slowQueries?.map((query, i) => (
                    <div key={i} className="border rounded p-2 space-y-1">
                      <div className="flex items-start justify-between">
                        <span className="text-xs font-medium truncate max-w-xs">
                          {query.endpoint}
                        </span>
                        <Badge variant="destructive">
                          {(query.responseTime / 1000).toFixed(1)}s
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(query.timestamp), 'PPpp')}
                      </p>
                      {query.userId && (
                        <p className="text-xs text-muted-foreground">
                          User: {query.userId.substring(0, 8)}...
                        </p>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No slow queries detected</p>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Performance by Metric</CardTitle>
            <CardDescription>Average values for tracked metrics</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64">
              <div className="space-y-2">
                {data?.metricTypes?.map((metric, i) => (
                  <div key={i} className="flex justify-between items-center">
                    <span className="text-sm font-medium">
                      {metric.metric.replace(/_/g, ' ')}
                    </span>
                    <div className="flex gap-2">
                      <Badge variant="outline">{metric.count} samples</Badge>
                      <Badge variant="secondary">
                        {metric.avgValue?.toFixed(2) || 0}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}