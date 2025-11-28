import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { UserActivityData, MonitoringWidgetProps } from '@/lib/monitoring/monitoring-types';

type UserActivityHeatmapProps = MonitoringWidgetProps<UserActivityData>;

export default function UserActivityHeatmap({ data, isLoading }: UserActivityHeatmapProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>User Activity</CardTitle>
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

  // Process heatmap data
  const heatmapGrid = Array(7).fill(null).map(() => Array(24).fill(0));
  data?.heatmapData?.forEach((item) => {
    const day = parseInt(item.day_of_week);
    const hour = parseInt(item.hour_of_day);
    if (day >= 0 && day < 7 && hour >= 0 && hour < 24) {
      heatmapGrid[day][hour] = parseInt(item.activity_count);
    }
  });

  const maxActivity = Math.max(...heatmapGrid.flat());
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const getHeatColor = (value: number) => {
    if (value === 0) return 'bg-muted';
    const intensity = value / maxActivity;
    if (intensity < 0.25) return 'bg-blue-200 dark:bg-blue-900';
    if (intensity < 0.5) return 'bg-blue-400 dark:bg-blue-700';
    if (intensity < 0.75) return 'bg-blue-600 dark:bg-blue-500';
    return 'bg-blue-800 dark:bg-blue-400';
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Activity Heatmap</CardTitle>
          <CardDescription>User activity by day and hour</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {/* Hour labels */}
            <div className="flex gap-1 ml-10">
              {Array(24).fill(null).map((_, i) => (
                <div key={i} className="w-4 text-xs text-muted-foreground text-center">
                  {i % 3 === 0 ? i : ''}
                </div>
              ))}
            </div>
            
            {/* Heatmap grid */}
            {heatmapGrid.map((row, dayIndex) => (
              <div key={dayIndex} className="flex gap-1 items-center">
                <div className="w-8 text-xs text-muted-foreground">{days[dayIndex]}</div>
                {row.map((value, hourIndex) => (
                  <div
                    key={hourIndex}
                    className={`w-4 h-4 rounded-sm ${getHeatColor(value)}`}
                    title={`${days[dayIndex]} ${hourIndex}:00 - ${value} activities`}
                  />
                ))}
              </div>
            ))}
          </div>
          
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <span>Less</span>
            <div className="flex gap-1">
              <div className="w-3 h-3 bg-muted rounded-sm" />
              <div className="w-3 h-3 bg-blue-200 dark:bg-blue-900 rounded-sm" />
              <div className="w-3 h-3 bg-blue-400 dark:bg-blue-700 rounded-sm" />
              <div className="w-3 h-3 bg-blue-600 dark:bg-blue-500 rounded-sm" />
              <div className="w-3 h-3 bg-blue-800 dark:bg-blue-400 rounded-sm" />
            </div>
            <span>More</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Most Active Users</CardTitle>
            <CardDescription>Top users by activity count</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64">
              <div className="space-y-2">
                {data?.mostActiveUsers?.map((user, i) => (
                  <div key={i} className="flex justify-between items-center">
                    <span className="text-sm font-medium">
                      {user.userName}
                    </span>
                    <Badge variant="secondary">{user.actionCount} actions</Badge>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Feature Usage</CardTitle>
            <CardDescription>Most used features</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64">
              <div className="space-y-2">
                {data?.featureUsage?.map((feature, i) => (
                  <div key={i} className="flex justify-between items-center">
                    <span className="text-sm font-medium">
                      {feature.action.replace(/_/g, ' ')}
                    </span>
                    <Badge variant="outline">{feature.count} uses</Badge>
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