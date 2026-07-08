import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertCircle, CheckCircle, Info, AlertTriangle, XCircle } from 'lucide-react';
import { format } from 'date-fns';
import type { SystemHealthData } from '@/lib/monitoring';

interface SystemHealthWidgetProps {
  data: SystemHealthData;
}

export default function SystemHealthWidget({ data }: SystemHealthWidgetProps) {
  const getLogLevelIcon = (level: string) => {
    switch (level) {
      case 'error':
      case 'fatal':
        return <XCircle className="h-4 w-4 text-destructive" />;
      case 'warn':
        return <AlertTriangle className="h-4 w-4 text-warning" />;
      case 'info':
        return <Info className="h-4 w-4 text-info" />;
      default:
        return <CheckCircle className="h-4 w-4 text-success" />;
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
          {data.activeUserCount} active users
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Log Levels */}
        <div>
          <h4 className="text-sm font-medium mb-2">Log Distribution</h4>
          <div className="grid grid-cols-2 gap-2">
            {data.logsByLevel.map((log) => (
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
              {data.recentErrors.length > 0 ? (
                data.recentErrors.map((error) => (
                  <div key={error.id} className="border rounded p-2 space-y-1">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-1">
                        <AlertCircle className="h-3 w-3 text-destructive mt-0.5" />
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
