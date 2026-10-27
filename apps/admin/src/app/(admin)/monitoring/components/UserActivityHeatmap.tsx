import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { UserActivityData } from '@/lib/monitoring';

interface UserActivityHeatmapProps {
  data: UserActivityData;
}

export default function UserActivityHeatmap({ data }: UserActivityHeatmapProps) {
  // Process heatmap data
  const heatmapGrid = Array(7).fill(null).map(() => Array(24).fill(0));
  data.heatmapData.forEach((item) => {
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
    if (intensity < 0.25) return 'bg-info/20';
    if (intensity < 0.5) return 'bg-info/45';
    if (intensity < 0.75) return 'bg-info/70';
    return 'bg-info';
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Activity Heatmap</CardTitle>
          <CardDescription>User activity by day and hour</CardDescription>
        </CardHeader>
        <CardContent>
          {/* The grid is ~500px wide; scroll it on small screens instead of overflowing the page */}
          <div className="overflow-x-auto">
            <div className="min-w-max space-y-2">
              {/* Hour labels */}
              <div className="ml-10 flex gap-1">
                {Array(24).fill(null).map((_, i) => (
                  <div key={i} className="w-4 text-center text-xs text-muted-foreground">
                    {i % 3 === 0 ? i : ''}
                  </div>
                ))}
              </div>

              {/* Heatmap grid */}
              {heatmapGrid.map((row, dayIndex) => (
                <div key={dayIndex} className="flex items-center gap-1">
                  <div className="w-8 text-xs text-muted-foreground">{days[dayIndex]}</div>
                  {row.map((value, hourIndex) => (
                    <div
                      key={hourIndex}
                      className={`h-4 w-4 rounded-sm ${getHeatColor(value)}`}
                      title={`${days[dayIndex]} ${hourIndex}:00 - ${value} activities`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <span>Less</span>
            <div className="flex gap-1">
              <div className="h-3 w-3 rounded-sm bg-muted" />
              <div className="h-3 w-3 rounded-sm bg-info/20" />
              <div className="h-3 w-3 rounded-sm bg-info/45" />
              <div className="h-3 w-3 rounded-sm bg-info/70" />
              <div className="h-3 w-3 rounded-sm bg-info" />
            </div>
            <span>More</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Most Active Users</CardTitle>
            <CardDescription>Top users by activity count</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64">
              <div className="space-y-2">
                {data.mostActiveUsers.length > 0 ? (
                  data.mostActiveUsers.map((user, i) => (
                    <div key={i} className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {user.userName}
                      </span>
                      <Badge variant="secondary" className="shrink-0">{user.actionCount} actions</Badge>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No activity in this range</p>
                )}
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
                {data.featureUsage.length > 0 ? (
                  data.featureUsage.map((feature, i) => (
                    <div key={i} className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {feature.action.replace(/_/g, ' ')}
                      </span>
                      <Badge variant="outline" className="shrink-0">{feature.count} uses</Badge>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No feature usage in this range</p>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
