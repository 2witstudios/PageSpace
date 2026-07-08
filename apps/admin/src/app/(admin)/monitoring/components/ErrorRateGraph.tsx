import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertCircle, AlertTriangle } from 'lucide-react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { format } from 'date-fns';
import type { ErrorAnalyticsData } from '@/lib/monitoring';

interface ErrorRateGraphProps {
  data: ErrorAnalyticsData;
  detailed?: boolean;
}

interface ErrorTrendRow {
  hour: string;
  auth: number;
  api: number;
  ai: number;
  database: number;
  [category: string]: string | number;
}

export default function ErrorRateGraph({ data, detailed = false }: ErrorRateGraphProps) {
  // Process error trends data
  const errorTrendsMap = new Map<string, ErrorTrendRow>();
  data.errorTrends.forEach((item) => {
    const hour = item.hour;
    if (!errorTrendsMap.has(hour)) {
      errorTrendsMap.set(hour, { hour, auth: 0, api: 0, ai: 0, database: 0 });
    }
    const hourData = errorTrendsMap.get(hour);
    if (hourData) {
      hourData[item.category || 'other'] = parseInt(item.count) || 0;
    }
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
            {data.errorPatterns.length} unique error patterns detected
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={errorTrendsData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 12 }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip
                contentStyle={{ backgroundColor: "var(--popover)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--popover-foreground)" }}
                labelStyle={{ color: "var(--popover-foreground)" }}
              />
              <Legend />
              <Line type="monotone" dataKey="auth" stroke="var(--destructive)" name="Auth" strokeWidth={2} />
              <Line type="monotone" dataKey="api" stroke="var(--chart-1)" name="API" strokeWidth={2} />
              <Line type="monotone" dataKey="ai" stroke="var(--chart-5)" name="AI" strokeWidth={2} />
              <Line type="monotone" dataKey="database" stroke="var(--chart-3)" name="Database" strokeWidth={2} />
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
                  data={data.errorPatterns.slice(0, 10)}
                  layout="horizontal"
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis type="number" />
                  <YAxis
                    dataKey="name"
                    type="category"
                    width={150}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: "var(--popover)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--popover-foreground)" }}
                    labelStyle={{ color: "var(--popover-foreground)" }}
                  />
                  <Bar dataKey="count" fill="var(--destructive)" name="Error Count" />
                </BarChart>
              </ResponsiveContainer>

              <div className="mt-4 space-y-2">
                <h4 className="text-sm font-medium">Error Details</h4>
                {data.errorPatterns.slice(0, 5).map((pattern, i) => (
                  <div key={i} className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <AlertTriangle className="h-3 w-3 shrink-0 text-warning" />
                      <span className="truncate text-sm text-muted-foreground">
                        {pattern.name}
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-2">
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
                  {data.failedLogins.length > 0 ? (
                    data.failedLogins.map((login, i) => (
                      <div key={i} className="border rounded p-2 space-y-1">
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-1">
                            <AlertCircle className="h-3 w-3 text-destructive mt-0.5" />
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
