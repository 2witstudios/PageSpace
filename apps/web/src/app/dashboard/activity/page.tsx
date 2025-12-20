"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft,
  Activity,
  AlertTriangle,
  Bot,
  Clock,
  FileText,
  FolderOpen,
  Plus,
  Pencil,
  Trash2,
  RotateCcw,
  Move,
  Shield,
  Settings,
  RefreshCw,
  Users,
  Loader2,
} from "lucide-react";
import { formatDistanceToNow, format, isToday, isYesterday, isThisWeek } from "date-fns";
import { toast } from "sonner";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";

// Types
interface ActivityUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

interface ActivityLog {
  id: string;
  timestamp: string;
  userId: string | null;
  actorEmail: string;
  actorDisplayName: string | null;
  operation: string;
  resourceType: string;
  resourceId: string;
  resourceTitle: string | null;
  driveId: string | null;
  pageId: string | null;
  isAiGenerated: boolean;
  aiProvider: string | null;
  aiModel: string | null;
  aiConversationId: string | null;
  updatedFields: string[] | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  user: ActivityUser | null;
}

interface Drive {
  id: string;
  name: string;
  slug: string;
}

interface Pagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

interface ActivityStats {
  total: number;
  today: number;
  thisWeek: number;
  byOperation: Record<string, number>;
  byResourceType: Record<string, number>;
  aiGenerated: number;
}

// Operation icons and labels
const operationConfig: Record<string, { icon: React.ElementType; label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  create: { icon: Plus, label: "Created", variant: "default" },
  update: { icon: Pencil, label: "Updated", variant: "secondary" },
  delete: { icon: Trash2, label: "Deleted", variant: "destructive" },
  restore: { icon: RotateCcw, label: "Restored", variant: "outline" },
  reorder: { icon: Move, label: "Reordered", variant: "secondary" },
  trash: { icon: Trash2, label: "Trashed", variant: "destructive" },
  move: { icon: Move, label: "Moved", variant: "secondary" },
  permission_grant: { icon: Shield, label: "Permission Granted", variant: "default" },
  permission_update: { icon: Shield, label: "Permission Updated", variant: "secondary" },
  permission_revoke: { icon: Shield, label: "Permission Revoked", variant: "destructive" },
  agent_config_update: { icon: Settings, label: "Agent Updated", variant: "secondary" },
};

// Resource type icons
const resourceTypeIcons: Record<string, React.ElementType> = {
  page: FileText,
  drive: FolderOpen,
  permission: Shield,
  agent: Bot,
};

// Helper functions
const getInitials = (name: string | null, email: string): string => {
  if (name) {
    return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
  }
  return email.slice(0, 2).toUpperCase();
};

const groupActivitiesByDate = (activities: ActivityLog[]): Map<string, ActivityLog[]> => {
  const groups = new Map<string, ActivityLog[]>();

  activities.forEach((activity) => {
    const date = new Date(activity.timestamp);
    let groupKey: string;

    if (isToday(date)) {
      groupKey = "Today";
    } else if (isYesterday(date)) {
      groupKey = "Yesterday";
    } else if (isThisWeek(date)) {
      groupKey = format(date, "EEEE"); // Day name
    } else {
      groupKey = format(date, "MMMM d, yyyy");
    }

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(activity);
  });

  return groups;
};

const calculateStats = (activities: ActivityLog[]): ActivityStats => {
  const stats: ActivityStats = {
    total: activities.length,
    today: 0,
    thisWeek: 0,
    byOperation: {},
    byResourceType: {},
    aiGenerated: 0,
  };

  activities.forEach((activity) => {
    const date = new Date(activity.timestamp);

    if (isToday(date)) stats.today++;
    if (isThisWeek(date)) stats.thisWeek++;
    if (activity.isAiGenerated) stats.aiGenerated++;

    stats.byOperation[activity.operation] = (stats.byOperation[activity.operation] || 0) + 1;
    stats.byResourceType[activity.resourceType] = (stats.byResourceType[activity.resourceType] || 0) + 1;
  });

  return stats;
};

// Activity Item Component
function ActivityItem({ activity }: { activity: ActivityLog }) {
  const opConfig = operationConfig[activity.operation] || {
    icon: Activity,
    label: activity.operation,
    variant: "secondary" as const,
  };
  const OpIcon = opConfig.icon;
  const ResourceIcon = resourceTypeIcons[activity.resourceType] || FileText;

  const actorName = activity.user?.name || activity.actorDisplayName || activity.actorEmail;
  const actorImage = activity.user?.image;

  return (
    <div className="flex items-start gap-4 py-4 border-b last:border-b-0">
      {/* Avatar */}
      <Avatar className="h-10 w-10 shrink-0">
        <AvatarImage src={actorImage || undefined} alt={actorName} />
        <AvatarFallback>{getInitials(activity.actorDisplayName, activity.actorEmail)}</AvatarFallback>
      </Avatar>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{actorName}</span>
          <Badge variant={opConfig.variant} className="text-xs">
            <OpIcon className="h-3 w-3 mr-1" />
            {opConfig.label}
          </Badge>
          {activity.isAiGenerated && (
            <Badge variant="outline" className="text-xs gap-1">
              <Bot className="h-3 w-3" />
              AI
              {activity.aiModel && <span className="text-muted-foreground">({activity.aiModel})</span>}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ResourceIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">
            {activity.resourceTitle || activity.resourceType}
          </span>
        </div>

        {/* Updated fields */}
        {activity.updatedFields && activity.updatedFields.length > 0 && (
          <div className="text-xs text-muted-foreground">
            Changed: {activity.updatedFields.join(", ")}
          </div>
        )}
      </div>

      {/* Timestamp */}
      <div className="text-xs text-muted-foreground shrink-0 text-right">
        <div>{format(new Date(activity.timestamp), "h:mm a")}</div>
        <div className="text-muted-foreground/60">
          {formatDistanceToNow(new Date(activity.timestamp), { addSuffix: true })}
        </div>
      </div>
    </div>
  );
}

// Stats Card Component
function StatsCard({
  title,
  value,
  description,
  icon: Icon,
}: {
  title: string;
  value: number | string;
  description?: string;
  icon: React.ElementType;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

// Main Component
export default function ActivityDashboard() {
  const router = useRouter();
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [activeTab, setActiveTab] = useState<"user" | "drive">("user");
  const [selectedDriveId, setSelectedDriveId] = useState<string>("");
  const [operationFilter, setOperationFilter] = useState<string>("all");
  const [resourceTypeFilter, setResourceTypeFilter] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);

  // Fetch drives
  const fetchDrives = useCallback(async () => {
    try {
      const response = await fetchWithAuth("/api/drives");
      if (!response.ok) throw new Error("Failed to fetch drives");
      const data = await response.json();
      setDrives(data);
      if (data.length > 0) {
        setSelectedDriveId((prev) => prev || data[0].id);
      }
    } catch (err) {
      console.error("Error fetching drives:", err);
    }
  }, []);

  // Fetch activities
  const fetchActivities = useCallback(
    async (offset = 0, append = false) => {
      if (!append) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);

      try {
        let url = `/api/activities?context=${activeTab}&limit=50&offset=${offset}`;

        if (activeTab === "drive" && selectedDriveId) {
          url += `&driveId=${selectedDriveId}`;
        }

        const response = await fetchWithAuth(url);
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to fetch activities");
        }

        const data = await response.json();

        // Apply client-side filters
        let filteredActivities = data.activities;
        if (operationFilter !== "all") {
          filteredActivities = filteredActivities.filter(
            (a: ActivityLog) => a.operation === operationFilter
          );
        }
        if (resourceTypeFilter !== "all") {
          filteredActivities = filteredActivities.filter(
            (a: ActivityLog) => a.resourceType === resourceTypeFilter
          );
        }

        if (append) {
          setActivities((prev) => [...prev, ...filteredActivities]);
        } else {
          setActivities(filteredActivities);
        }
        setPagination(data.pagination);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to fetch activities";
        setError(message);
        toast.error(message);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [activeTab, selectedDriveId, operationFilter, resourceTypeFilter]
  );

  // Initial load
  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  // Fetch activities when tab, drive, or filters change
  useEffect(() => {
    if (activeTab === "drive" && !selectedDriveId && drives.length > 0) {
      setSelectedDriveId(drives[0].id);
      return;
    }
    if (activeTab === "user" || (activeTab === "drive" && selectedDriveId)) {
      fetchActivities();
    }
  }, [activeTab, selectedDriveId, operationFilter, resourceTypeFilter, fetchActivities, drives]);

  // Load more
  const handleLoadMore = () => {
    if (pagination?.hasMore) {
      fetchActivities(pagination.offset + pagination.limit, true);
    }
  };

  // Refresh
  const handleRefresh = () => {
    fetchActivities();
    toast.success("Activity refreshed");
  };

  // Calculate stats
  const stats = calculateStats(activities);
  const groupedActivities = groupActivitiesByDate(activities);

  // Loading skeleton
  if (loading && activities.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10">
          <div className="space-y-6">
            <Skeleton className="h-8 w-48" />
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
            <Skeleton className="h-96" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10">
        {/* Header */}
        <div className="mb-8">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/dashboard")}
            className="mb-4"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold mb-2">Activity Dashboard</h1>
              <p className="text-muted-foreground">
                Track your actions and changes across all your drives
              </p>
            </div>
            <Button
              onClick={handleRefresh}
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
          <StatsCard
            title="Total Activities"
            value={pagination?.total || stats.total}
            description="All time activities"
            icon={Activity}
          />
          <StatsCard
            title="Today"
            value={stats.today}
            description="Actions performed today"
            icon={Clock}
          />
          <StatsCard
            title="This Week"
            value={stats.thisWeek}
            description="Actions this week"
            icon={Clock}
          />
          <StatsCard
            title="AI Generated"
            value={stats.aiGenerated}
            description="Actions by AI assistants"
            icon={Bot}
          />
        </div>

        {/* Tabs and Filters */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "user" | "drive")}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
            <TabsList>
              <TabsTrigger value="user" className="gap-2">
                <Users className="h-4 w-4" />
                My Activity
              </TabsTrigger>
              <TabsTrigger value="drive" className="gap-2">
                <FolderOpen className="h-4 w-4" />
                Drive Activity
              </TabsTrigger>
            </TabsList>

            <div className="flex flex-wrap gap-2">
              {/* Drive selector (only for drive tab) */}
              {activeTab === "drive" && drives.length > 0 && (
                <Select
                  value={selectedDriveId}
                  onValueChange={setSelectedDriveId}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Select drive" />
                  </SelectTrigger>
                  <SelectContent>
                    {drives.map((drive) => (
                      <SelectItem key={drive.id} value={drive.id}>
                        {drive.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {/* Operation filter */}
              <Select
                value={operationFilter}
                onValueChange={setOperationFilter}
              >
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Operation" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Operations</SelectItem>
                  {Object.entries(operationConfig).map(([key, config]) => (
                    <SelectItem key={key} value={key}>
                      {config.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Resource type filter */}
              <Select
                value={resourceTypeFilter}
                onValueChange={setResourceTypeFilter}
              >
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Resource Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="page">Pages</SelectItem>
                  <SelectItem value="drive">Drives</SelectItem>
                  <SelectItem value="permission">Permissions</SelectItem>
                  <SelectItem value="agent">Agents</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Activity Feed */}
          <TabsContent value="user" className="mt-0">
            <Card>
              <CardHeader>
                <CardTitle>My Activity</CardTitle>
                <CardDescription>
                  Your recent actions across all drives
                </CardDescription>
              </CardHeader>
              <CardContent>
                {activities.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Activity className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No activity found</p>
                    <p className="text-sm">Your actions will appear here</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {Array.from(groupedActivities.entries()).map(([dateGroup, groupActivities]) => (
                      <div key={dateGroup}>
                        <h3 className="text-sm font-semibold text-muted-foreground mb-2 sticky top-0 bg-background py-2">
                          {dateGroup}
                        </h3>
                        <div className="space-y-0">
                          {groupActivities.map((activity) => (
                            <ActivityItem key={activity.id} activity={activity} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Load More */}
                {pagination?.hasMore && (
                  <div className="mt-6 text-center">
                    <Button
                      variant="outline"
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                    >
                      {loadingMore ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Loading...
                        </>
                      ) : (
                        "Load More"
                      )}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="drive" className="mt-0">
            <Card>
              <CardHeader>
                <CardTitle>
                  {drives.find((d) => d.id === selectedDriveId)?.name || "Drive"} Activity
                </CardTitle>
                <CardDescription>
                  All activity within this drive by all members
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!selectedDriveId ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <FolderOpen className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>Select a drive to view activity</p>
                  </div>
                ) : activities.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Activity className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No activity found in this drive</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {Array.from(groupedActivities.entries()).map(([dateGroup, groupActivities]) => (
                      <div key={dateGroup}>
                        <h3 className="text-sm font-semibold text-muted-foreground mb-2 sticky top-0 bg-background py-2">
                          {dateGroup}
                        </h3>
                        <div className="space-y-0">
                          {groupActivities.map((activity) => (
                            <ActivityItem key={activity.id} activity={activity} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Load More */}
                {pagination?.hasMore && selectedDriveId && (
                  <div className="mt-6 text-center">
                    <Button
                      variant="outline"
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                    >
                      {loadingMore ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Loading...
                        </>
                      ) : (
                        "Load More"
                      )}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Activity Breakdown */}
        {activities.length > 0 && (
          <div className="grid gap-6 md:grid-cols-2 mt-8">
            {/* By Operation */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">By Operation</CardTitle>
                <CardDescription>Breakdown of activity types</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {Object.entries(stats.byOperation)
                    .sort(([, a], [, b]) => b - a)
                    .map(([operation, count]) => {
                      const config = operationConfig[operation] || {
                        icon: Activity,
                        label: operation,
                        variant: "secondary" as const,
                      };
                      const Icon = config.icon;
                      const percentage = Math.round((count / stats.total) * 100);

                      return (
                        <div key={operation} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm">{config.label}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{count}</span>
                            <span className="text-xs text-muted-foreground w-10 text-right">
                              {percentage}%
                            </span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </CardContent>
            </Card>

            {/* By Resource Type */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">By Resource</CardTitle>
                <CardDescription>What types of resources were changed</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {Object.entries(stats.byResourceType)
                    .sort(([, a], [, b]) => b - a)
                    .map(([resourceType, count]) => {
                      const Icon = resourceTypeIcons[resourceType] || FileText;
                      const percentage = Math.round((count / stats.total) * 100);

                      return (
                        <div key={resourceType} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm capitalize">{resourceType}s</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{count}</span>
                            <span className="text-xs text-muted-foreground w-10 text-right">
                              {percentage}%
                            </span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
