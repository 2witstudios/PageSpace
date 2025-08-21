import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, 
  Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { format } from 'date-fns';
import type { ApiMetricsData, DetailedWidgetProps } from '@/lib/monitoring-types';

type ApiMetricsChartProps = DetailedWidgetProps<ApiMetricsData>;

export default function ApiMetricsChart({ data, isLoading, detailed = false }: ApiMetricsChartProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API Metrics</CardTitle>
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

  // Format volume data for chart
  const volumeData = data?.volumeOverTime?.map((item) => ({
    time: format(new Date(item.hour), 'MMM dd HH:mm'),
    requests: parseInt(item.count),
    avgResponseTime: parseFloat(item.avg_response_time) || 0,
  })).reverse() || [];

  return (
    <>
      <Card className={detailed ? '' : ''}>
        <CardHeader>
          <CardTitle>API Request Volume</CardTitle>
          <CardDescription>
            Total: {data?.totalRequests || 0} requests | 
            Error rate: <Badge variant={(data?.errorRate || 0) > 5 ? 'destructive' : 'secondary'}>
              {data?.errorRate?.toFixed(1) || 0}%
            </Badge>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={volumeData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis 
                dataKey="time" 
                tick={{ fontSize: 12 }}
                interval="preserveStartEnd"
              />
              <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Line 
                yAxisId="left"
                type="monotone" 
                dataKey="requests" 
                stroke="#8884d8" 
                name="Requests"
                strokeWidth={2}
              />
              <Line 
                yAxisId="right"
                type="monotone" 
                dataKey="avgResponseTime" 
                stroke="#82ca9d" 
                name="Avg Response (ms)"
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {detailed && (
        <Card>
          <CardHeader>
            <CardTitle>Top Endpoints</CardTitle>
            <CardDescription>Most frequently accessed API endpoints</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart 
                data={data?.topEndpoints || []}
                layout="horizontal"
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis 
                  dataKey="endpoint" 
                  type="category" 
                  width={150}
                  tick={{ fontSize: 10 }}
                />
                <Tooltip />
                <Bar dataKey="count" fill="#8884d8" name="Request Count" />
              </BarChart>
            </ResponsiveContainer>
            
            <div className="mt-4 space-y-2">
              <h4 className="text-sm font-medium">Endpoint Details</h4>
              {data?.topEndpoints?.map((endpoint, i) => (
                <div key={i} className="flex justify-between items-center text-sm">
                  <span className="text-muted-foreground truncate max-w-xs">
                    {endpoint.endpoint}
                  </span>
                  <div className="flex gap-2">
                    <Badge variant="outline">{endpoint.count} requests</Badge>
                    <Badge variant="secondary">
                      {endpoint.avgResponseTime?.toFixed(0) || 0}ms avg
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}