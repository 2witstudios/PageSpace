import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertCircle, AlertTriangle } from 'lucide-react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, 
  Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { format } from 'date-fns';
import type { ErrorAnalyticsData, DetailedWidgetProps } from '@/lib/monitoring/monitoring-types';

type ErrorRateGraphProps = DetailedWidgetProps<ErrorAnalyticsData>;

export default function ErrorRateGraph({ data, isLoading, detailed = false }: ErrorRateGraphProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error Analysis</CardTitle>
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

  // Process error trends data
  const errorTrendsMap = new Map();
  data?.errorTrends?.forEach((item) => {
    const hour = item.hour;
    if (!errorTrendsMap.has(hour)) {
      errorTrendsMap.set(hour, { hour, auth: 0, api: 0, ai: 0, database: 0 });
    }
    const hourData = errorTrendsMap.get(hour);
    hourData[item.category || 'other'] = parseInt(item.count) || 0;
  });

  const errorTrendsData = Array.from(errorTrendsMap.values())
    .sort((a, b) => new Date(a.hour).getTime() - new Date(b.hour).getTime())
    .map(item => ({
      ...item,
      time: format(new Date(item.hour), 'MMM dd HH:mm'),
    }));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Error Rate Trends</CardTitle>
          <CardDescription>
            {data?.errorPatterns?.length || 0} unique error patterns detected
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={errorTrendsData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis 
                dataKey="time" 
                tick={{ fontSize: 12 }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="auth" stroke="#FF6B6B" name="Auth" strokeWidth={2} />
              <Line type="monotone" dataKey="api" stroke="#FFA500" name="API" strokeWidth={2} />
              <Line type="monotone" dataKey="ai" stroke="#8884d8" name="AI" strokeWidth={2} />
              <Line type="monotone" dataKey="database" stroke="#82ca9d" name="Database" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {detailed && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Error Patterns</CardTitle>
              <CardDescription>Most common error types</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart 
                  data={data?.errorPatterns?.slice(0, 10) || []}
                  layout="horizontal"
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" />
                  <YAxis 
                    dataKey="name" 
                    type="category" 
                    width={150}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip />
                  <Bar dataKey="count" fill="#FF6B6B" name="Error Count" />
                </BarChart>
              </ResponsiveContainer>
              
              <div className="mt-4 space-y-2">
                <h4 className="text-sm font-medium">Error Details</h4>
                {data?.errorPatterns?.slice(0, 5).map((pattern, i) => (
                  <div key={i} className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-3 w-3 text-yellow-500" />
                      <span className="text-sm text-muted-foreground">
                        {pattern.name}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <Badge variant="outline">{pattern.category}</Badge>
                      <Badge variant="destructive">{pattern.count} errors</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Failed Login Attempts</CardTitle>
              <CardDescription>Recent authentication failures</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-64">
                <div className="space-y-2">
                  {(data?.failedLogins?.length || 0) > 0 ? (
                    data?.failedLogins?.map((login, i) => (
                      <div key={i} className="border rounded p-2 space-y-1">
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-1">
                            <AlertCircle className="h-3 w-3 text-red-500 mt-0.5" />
                            <span className="text-xs font-medium">Failed Login</span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(login.timestamp), 'PPpp')}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          IP: {login.ip || 'Unknown'}
                        </p>
                        {login.metadata?.email && (
                          <p className="text-xs text-muted-foreground">
                            Email: {login.metadata.email}
                          </p>
                        )}
                        {login.metadata?.reason && (
                          <Badge variant="outline" className="text-xs">
                            {login.metadata.reason}
                          </Badge>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">No failed login attempts</p>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}