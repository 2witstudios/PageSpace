'use client';

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import { formatDistanceToNow, format } from 'date-fns';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Shield,
  Download,
  FileText,
  Filter,
  Search,
  Bot,
  User,
  BarChart3,
  RefreshCw,
  Calendar,
} from 'lucide-react';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth-fetch';

interface AuditEvent {
  id: string;
  timestamp: string;
  actionType: string;
  entityType: string;
  entityId: string;
  userId: string | null;
  driveId: string | null;
  isAiAction: boolean;
  description: string;
  reason: string | null;
  user: {
    id: string;
    name: string;
    email: string;
  } | null;
}

interface AuditExportResponse {
  exportedAt: string;
  exportedBy: {
    id: string;
    email: string;
  };
  filters: Record<string, unknown>;
  recordCount: number;
  records: AuditEvent[];
}

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error('Failed to fetch audit data');
  }
  return response.json();
};

const getUserInitials = (name: string) => {
  return name
    .split(' ')
    .map(part => part.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 2);
};

export default function AdminAuditPage() {
  const [category, setCategory] = useState<string>('');
  const [actionType, setActionType] = useState<string>('');
  const [userId, setUserId] = useState<string>('');
  const [driveId, setDriveId] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [isExporting, setIsExporting] = useState(false);

  // Build query URL
  const buildUrl = () => {
    const params = new URLSearchParams({
      limit: '1000',
    });

    if (category) params.append('category', category);
    if (actionType) params.append('actionType', actionType);
    if (userId) params.append('userId', userId);
    if (driveId) params.append('driveId', driveId);
    if (fromDate) params.append('fromDate', new Date(fromDate).toISOString());
    if (toDate) params.append('toDate', new Date(toDate).toISOString());

    return `/api/admin/audit/export?${params.toString()}`;
  };

  const { data, error, isLoading, mutate } = useSWR<AuditExportResponse>(
    buildUrl(),
    fetcher,
    {
      revalidateOnFocus: false,
    }
  );

  // Filter data by search term
  const filteredData = useMemo(() => {
    if (!data?.records || !searchTerm) return data?.records || [];

    const term = searchTerm.toLowerCase();
    return data.records.filter(
      (record) =>
        record.description.toLowerCase().includes(term) ||
        record.user?.name.toLowerCase().includes(term) ||
        record.user?.email.toLowerCase().includes(term) ||
        record.entityId.toLowerCase().includes(term)
    );
  }, [data?.records, searchTerm]);

  // Calculate statistics
  const stats = useMemo(() => {
    const records = filteredData || [];
    const aiActions = records.filter((r) => r.isAiAction).length;
    const humanActions = records.length - aiActions;

    const userCounts = records.reduce((acc, record) => {
      if (record.user) {
        acc[record.user.name] = (acc[record.user.name] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);

    const topUsers = Object.entries(userCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);

    return {
      total: records.length,
      aiActions,
      humanActions,
      aiPercentage: records.length > 0 ? (aiActions / records.length) * 100 : 0,
      topUsers,
    };
  }, [filteredData]);

  const handleExport = async (format: 'json' | 'csv') => {
    setIsExporting(true);
    try {
      const url = buildUrl() + `&format=${format}`;
      const response = await fetchWithAuth(url);

      if (!response.ok) {
        throw new Error('Export failed');
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `audit-export-${new Date().toISOString().split('T')[0]}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);

      toast.success(`Audit log exported as ${format.toUpperCase()}`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export audit log');
    } finally {
      setIsExporting(false);
    }
  };

  const resetFilters = () => {
    setCategory('');
    setActionType('');
    setUserId('');
    setDriveId('');
    setFromDate('');
    setToDate('');
    setSearchTerm('');
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Shield className="h-8 w-8" />
            Audit Log Dashboard
          </h1>
          <p className="text-muted-foreground mt-1">
            Monitor and review all system activities
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => mutate()}
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            onClick={() => handleExport('csv')}
            disabled={isExporting}
          >
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
          <Button
            onClick={() => handleExport('json')}
            disabled={isExporting}
          >
            <Download className="h-4 w-4 mr-2" />
            Export JSON
          </Button>
        </div>
      </div>

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Events</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats.total.toLocaleString()}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>AI Actions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold flex items-center gap-2">
              <Bot className="h-6 w-6 text-primary" />
              {stats.aiActions.toLocaleString()}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {stats.aiPercentage.toFixed(1)}% of total
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Human Actions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold flex items-center gap-2">
              <User className="h-6 w-6 text-primary" />
              {stats.humanActions.toLocaleString()}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {(100 - stats.aiPercentage).toFixed(1)}% of total
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Most Active User</CardDescription>
          </CardHeader>
          <CardContent>
            {stats.topUsers.length > 0 ? (
              <>
                <div className="text-xl font-bold truncate">
                  {stats.topUsers[0][0]}
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {stats.topUsers[0][1]} actions
                </p>
              </>
            ) : (
              <div className="text-muted-foreground">No data</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="category">
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All Categories</SelectItem>
                  <SelectItem value="page">Page</SelectItem>
                  <SelectItem value="permission">Permission</SelectItem>
                  <SelectItem value="ai">AI</SelectItem>
                  <SelectItem value="file">File</SelectItem>
                  <SelectItem value="drive">Drive</SelectItem>
                  <SelectItem value="auth">Authentication</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="action-type">Action Type</Label>
              <Input
                id="action-type"
                placeholder="e.g., PAGE_CREATE"
                value={actionType}
                onChange={(e) => setActionType(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="user-id">User ID</Label>
              <Input
                id="user-id"
                placeholder="Filter by user ID"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="drive-id">Drive ID</Label>
              <Input
                id="drive-id"
                placeholder="Filter by drive ID"
                value={driveId}
                onChange={(e) => setDriveId(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="from-date">From Date</Label>
              <Input
                id="from-date"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="to-date">To Date</Label>
              <Input
                id="to-date"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
          </div>

          <div className="flex justify-between items-center pt-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search in results..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Button variant="outline" onClick={resetFilters}>
              Reset All Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Audit Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Audit Events
          </CardTitle>
          <CardDescription>
            Showing {filteredData?.length || 0} of {stats.total} events
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="text-center text-destructive p-8">
              Failed to load audit data. Please try again.
            </div>
          ) : isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : filteredData && filteredData.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredData.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="text-sm">
                            {formatDistanceToNow(new Date(event.timestamp), {
                              addSuffix: true,
                            })}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(event.timestamp), 'MMM d, HH:mm:ss')}
                          </span>
                        </div>
                      </TableCell>

                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback>
                              {event.user
                                ? getUserInitials(event.user.name)
                                : 'AI'}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="text-sm font-medium">
                              {event.user?.name || 'AI'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {event.user?.email || 'System'}
                            </p>
                          </div>
                        </div>
                      </TableCell>

                      <TableCell>
                        <Badge variant="outline">
                          {event.actionType.replace(/_/g, ' ')}
                        </Badge>
                      </TableCell>

                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="text-sm font-medium">
                            {event.entityType}
                          </span>
                          <span className="text-xs text-muted-foreground font-mono">
                            {event.entityId.slice(0, 8)}...
                          </span>
                        </div>
                      </TableCell>

                      <TableCell>
                        <div className="max-w-md">
                          <p className="text-sm">{event.description}</p>
                          {event.reason && (
                            <p className="text-xs text-muted-foreground italic mt-1">
                              {event.reason}
                            </p>
                          )}
                        </div>
                      </TableCell>

                      <TableCell>
                        {event.isAiAction ? (
                          <Badge variant="secondary">
                            <Bot className="h-3 w-3 mr-1" />
                            AI
                          </Badge>
                        ) : (
                          <Badge variant="outline">
                            <User className="h-3 w-3 mr-1" />
                            Human
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center p-8 text-muted-foreground">
              <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No audit events found</p>
              <p className="text-sm mt-1">Try adjusting your filters</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
