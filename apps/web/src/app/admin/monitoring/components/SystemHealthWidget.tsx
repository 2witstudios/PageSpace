import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertCircle, CheckCircle, Info, AlertTriangle, XCircle } from 'lucide-react';
import { format } from 'date-fns';
import type { SystemHealthData, MonitoringWidgetProps } from '@/lib/monitoring-types';

type SystemHealthWidgetProps = MonitoringWidgetProps<SystemHealthData>;

export default function SystemHealthWidget({ data, isLoading }: SystemHealthWidgetProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>System Health</CardTitle>
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

  const getLogLevelIcon = (level: string) => {
    switch (level) {
      case 'error':
      case 'fatal':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'warn':
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      case 'info':
        return <Info className="h-4 w-4 text-blue-500" />;
      default:
        return <CheckCircle className="h-4 w-4 text-green-500" />;
    }
  };

  const getLogLevelBadge = (level: string, count: number) => {
    const variant = level === 'error' || level === 'fatal' ? 'destructive' : 
                   level === 'warn' ? 'secondary' : 'default';
    return (
      <div className="flex items-center gap-2">
        {getLogLevelIcon(level)}
        <span className="capitalize">{level}</span>
        <Badge variant={variant as 'default' | 'secondary' | 'destructive' | 'outline'}>{count}</Badge>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>System Health Overview</CardTitle>
        <CardDescription>
          {data?.activeUserCount || 0} active users
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Log Levels */}
        <div>
          <h4 className="text-sm font-medium mb-2">Log Distribution</h4>
          <div className="grid grid-cols-2 gap-2">
            {data?.logsByLevel?.map((log) => (
              <div key={log.level}>
                {getLogLevelBadge(log.level, log.count)}
              </div>
            ))}
          </div>
        </div>

        {/* Recent Errors */}
        <div>
          <h4 className="text-sm font-medium mb-2">Recent Errors</h4>
          <ScrollArea className="h-48">
            <div className="space-y-2">
              {(data?.recentErrors?.length || 0) > 0 ? (
                data?.recentErrors?.map((error) => (
                  <div key={error.id} className="border rounded p-2 space-y-1">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-1">
                        <AlertCircle className="h-3 w-3 text-red-500 mt-0.5" />
                        <span className="text-xs font-medium">{error.errorName || 'Error'}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(error.timestamp), 'HH:mm:ss')}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {error.errorMessage || error.message}
                    </p>
                    {error.endpoint && (
                      <p className="text-xs text-muted-foreground">
                        Endpoint: {error.endpoint}
                      </p>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No recent errors</p>
              )}
            </div>
          </ScrollArea>
        </div>
      </CardContent>
    </Card>
  );
}