'use client';

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  FileText,
  FilePlus,
  FileEdit,
  Trash2,
  Users,
  Shield,
  Bot,
  User,
  Calendar,
  Filter,
  RefreshCw,
} from 'lucide-react';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { fetchWithAuth } from '@/lib/auth-fetch';

interface ActivityEvent {
  id: string;
  actionType: string;
  entityType: string;
  entityId: string;
  userId: string | null;
  isAiAction: boolean;
  description: string;
  reason: string | null;
  createdAt: string;
  user: {
    id: string;
    name: string;
    image: string | null;
  } | null;
  page: {
    id: string;
    title: string;
    type: string;
  } | null;
  changes: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

interface ActivityFeedResponse {
  driveId: string;
  events: ActivityEvent[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
  filters: {
    actionType?: string;
    fromDate?: string;
    toDate?: string;
    includeAi: boolean;
    includeHuman: boolean;
  };
}

interface ActivityFeedProps {
  driveId: string;
  showFilters?: boolean;
  maxHeight?: string;
  limit?: number;
}

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error('Failed to fetch activity feed');
  }
  return response.json();
};

const getActionIcon = (actionType: string) => {
  if (actionType.includes('CREATE')) return <FilePlus className="h-4 w-4" />;
  if (actionType.includes('UPDATE') || actionType.includes('EDIT')) return <FileEdit className="h-4 w-4" />;
  if (actionType.includes('DELETE')) return <Trash2 className="h-4 w-4" />;
  if (actionType.includes('PERMISSION')) return <Shield className="h-4 w-4" />;
  if (actionType.includes('MEMBER')) return <Users className="h-4 w-4" />;
  return <FileText className="h-4 w-4" />;
};

const getActionColor = (actionType: string) => {
  if (actionType.includes('CREATE')) return 'default';
  if (actionType.includes('UPDATE') || actionType.includes('EDIT')) return 'secondary';
  if (actionType.includes('DELETE')) return 'destructive';
  if (actionType.includes('PERMISSION')) return 'outline';
  return 'secondary';
};

const getUserInitials = (name: string) => {
  return name
    .split(' ')
    .map(part => part.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 2);
};

export function ActivityFeed({
  driveId,
  showFilters = true,
  maxHeight = '600px',
  limit = 50,
}: ActivityFeedProps) {
  const [filterType, setFilterType] = useState<string>('all');
  const [includeAi, setIncludeAi] = useState(true);
  const [includeHuman, setIncludeHuman] = useState(true);
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [offset, setOffset] = useState(0);

  // Build query URL with filters
  const buildUrl = () => {
    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: offset.toString(),
      includeAi: includeAi.toString(),
      includeHuman: includeHuman.toString(),
    });

    if (filterType && filterType !== 'all') {
      params.append('filter', filterType);
    }
    if (fromDate) {
      params.append('fromDate', new Date(fromDate).toISOString());
    }
    if (toDate) {
      params.append('toDate', new Date(toDate).toISOString());
    }

    return `/api/drives/${driveId}/activity?${params.toString()}`;
  };

  const { data, error, isLoading, mutate } = useSWR<ActivityFeedResponse>(
    buildUrl(),
    fetcher,
    {
      revalidateOnFocus: true,
      refreshInterval: 30000, // Refresh every 30 seconds
    }
  );

  // Reset offset when filters change
  useEffect(() => {
    setOffset(0);
  }, [filterType, includeAi, includeHuman, fromDate, toDate]);

  const loadMore = () => {
    if (data?.pagination.hasMore) {
      setOffset(prev => prev + limit);
    }
  };

  const resetFilters = () => {
    setFilterType('all');
    setIncludeAi(true);
    setIncludeHuman(true);
    setFromDate('');
    setToDate('');
    setOffset(0);
  };

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="text-center text-destructive">
            Failed to load activity feed. Please try again.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Activity Feed
            </CardTitle>
            <CardDescription>
              Track all changes and actions in this drive
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => mutate()}
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      {showFilters && (
        <CardContent className="border-b pb-4">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <Label className="text-sm font-medium">Filters</Label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label htmlFor="action-type" className="text-xs">
                  Action Type
                </Label>
                <Select value={filterType} onValueChange={setFilterType}>
                  <SelectTrigger id="action-type">
                    <SelectValue placeholder="All actions" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Actions</SelectItem>
                    <SelectItem value="PAGE_CREATE">Page Created</SelectItem>
                    <SelectItem value="PAGE_UPDATE">Page Updated</SelectItem>
                    <SelectItem value="PAGE_DELETE">Page Deleted</SelectItem>
                    <SelectItem value="PERMISSION_GRANT">Permission Granted</SelectItem>
                    <SelectItem value="PERMISSION_REVOKE">Permission Revoked</SelectItem>
                    <SelectItem value="MEMBER_ADD">Member Added</SelectItem>
                    <SelectItem value="MEMBER_REMOVE">Member Removed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="from-date" className="text-xs">
                  From Date
                </Label>
                <Input
                  id="from-date"
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="to-date" className="text-xs">
                  To Date
                </Label>
                <Input
                  id="to-date"
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Source</Label>
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeHuman}
                      onChange={(e) => setIncludeHuman(e.target.checked)}
                      className="rounded"
                    />
                    <span className="text-sm flex items-center gap-1">
                      <User className="h-3 w-3" />
                      Human
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeAi}
                      onChange={(e) => setIncludeAi(e.target.checked)}
                      className="rounded"
                    />
                    <span className="text-sm flex items-center gap-1">
                      <Bot className="h-3 w-3" />
                      AI
                    </span>
                  </label>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={resetFilters}>
                Reset Filters
              </Button>
            </div>
          </div>
        </CardContent>
      )}

      <CardContent className="p-0">
        <ScrollArea style={{ height: maxHeight }}>
          {isLoading && offset === 0 ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : data?.events.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No activity found</p>
              <p className="text-sm mt-1">Try adjusting your filters</p>
            </div>
          ) : (
            <div className="divide-y">
              {data?.events.map((event) => (
                <div
                  key={event.id}
                  className="p-4 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    {/* User Avatar */}
                    <div className="relative">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={event.user?.image || undefined} />
                        <AvatarFallback>
                          {event.user
                            ? getUserInitials(event.user.name)
                            : 'AI'}
                        </AvatarFallback>
                      </Avatar>
                      {event.isAiAction && (
                        <div className="absolute -bottom-1 -right-1 bg-primary rounded-full p-1">
                          <Bot className="h-3 w-3 text-primary-foreground" />
                        </div>
                      )}
                    </div>

                    {/* Event Details */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          <p className="text-sm">
                            <span className="font-medium">
                              {event.user?.name || 'AI Assistant'}
                            </span>{' '}
                            <span className="text-muted-foreground">
                              {event.description}
                            </span>
                          </p>

                          {event.page && (
                            <Link
                              href={`/pages/${event.page.id}`}
                              className="inline-flex items-center gap-1.5 mt-1 text-sm text-primary hover:underline"
                            >
                              <PageTypeIcon type={event.page.type} className="h-3.5 w-3.5" />
                              {event.page.title}
                            </Link>
                          )}

                          {event.reason && (
                            <p className="text-xs text-muted-foreground mt-1 italic">
                              {event.reason}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-col items-end gap-1">
                          <Badge
                            variant={getActionColor(event.actionType)}
                            className="text-xs"
                          >
                            {getActionIcon(event.actionType)}
                            <span className="ml-1">
                              {event.actionType.replace(/_/g, ' ')}
                            </span>
                          </Badge>

                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {formatDistanceToNow(new Date(event.createdAt), {
                              addSuffix: true,
                            })}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              {data?.pagination.hasMore && (
                <div className="p-4 text-center">
                  <Button
                    variant="outline"
                    onClick={loadMore}
                    disabled={isLoading}
                  >
                    {isLoading ? 'Loading...' : 'Load More'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
