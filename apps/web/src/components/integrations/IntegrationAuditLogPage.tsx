'use client';

import { useState, useMemo, useCallback } from 'react';
import { format } from 'date-fns';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertCircle,
  Activity,
  Download,
  CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Filter,
  X,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { useIntegrationAuditLogs, useDriveConnections } from '@/hooks/useIntegrations';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';
import type { AuditLogsParams } from '@/hooks/useIntegrations';

interface IntegrationAuditLogPageProps {
  driveId: string;
}

type SuccessFilter = 'all' | 'true' | 'false';

interface FiltersState {
  connectionId: string;
  success: SuccessFilter;
  dateFrom: Date | undefined;
  dateTo: Date | undefined;
  agentId: string;
}

const PAGE_SIZE = 50;

function filtersToSearchParams(filters: FiltersState): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.connectionId) params.set('connectionId', filters.connectionId);
  if (filters.success !== 'all') params.set('success', filters.success);
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom.toISOString());
  if (filters.dateTo) params.set('dateTo', filters.dateTo.toISOString());
  if (filters.agentId) params.set('agentId', filters.agentId);
  return params;
}

function formatDateTime(dateString: string | null) {
  if (!dateString) return 'N/A';
  return format(new Date(dateString), 'MMM d, yyyy HH:mm:ss');
}

export function IntegrationAuditLogPage({ driveId }: IntegrationAuditLogPageProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState<FiltersState>({
    connectionId: '',
    success: 'all',
    dateFrom: undefined,
    dateTo: undefined,
    agentId: '',
  });

  const { connections } = useDriveConnections(driveId);

  // Build hook params from current filters and page
  const hookParams: AuditLogsParams = useMemo(() => {
    const params: AuditLogsParams = {
      limit: PAGE_SIZE,
      offset: (currentPage - 1) * PAGE_SIZE,
    };
    if (filters.connectionId) params.connectionId = filters.connectionId;
    if (filters.success !== 'all') params.success = filters.success === 'true';
    if (filters.dateFrom) params.dateFrom = filters.dateFrom.toISOString();
    if (filters.dateTo) params.dateTo = filters.dateTo.toISOString();
    if (filters.agentId) params.agentId = filters.agentId;
    return params;
  }, [currentPage, filters]);

  const { logs, total, isLoading, error } = useIntegrationAuditLogs(driveId, hookParams);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasNextPage = currentPage < totalPages;
  const hasPreviousPage = currentPage > 1;

  // Compute stats from current page
  const successCount = logs.filter((l) => l.success).length;
  const successRate = logs.length > 0 ? Math.round((successCount / logs.length) * 100) : 0;
  const avgDuration = logs.length > 0
    ? Math.round(logs.reduce((sum, l) => sum + (l.durationMs ?? 0), 0) / logs.length)
    : 0;

  const hasActiveFilters =
    filters.connectionId ||
    filters.success !== 'all' ||
    filters.dateFrom ||
    filters.dateTo ||
    filters.agentId;

  const clearFilters = () => {
    setFilters({
      connectionId: '',
      success: 'all',
      dateFrom: undefined,
      dateTo: undefined,
      agentId: '',
    });
    setCurrentPage(1);
  };

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const params = filtersToSearchParams(filters);

      const response = await fetchWithAuth(
        `/api/drives/${driveId}/integrations/audit/export?${params.toString()}`
      );

      if (!response.ok) throw new Error('Failed to export audit logs');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `integration-audit-logs-${format(new Date(), 'yyyy-MM-dd-HHmmss')}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch {
      toast.error('Failed to export audit logs');
    } finally {
      setExporting(false);
    }
  }, [driveId, filters]);

  // Loading skeleton
  if (isLoading && logs.length === 0) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96" />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="text-center">
                  <Skeleton className="h-8 w-16 mx-auto mb-2" />
                  <Skeleton className="h-4 w-20 mx-auto" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full mb-2" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error state
  if (error && logs.length === 0) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Error loading audit logs: {error instanceof Error ? error.message : 'Unknown error'}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {/* Overview Stats Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Activity className="h-5 w-5" />
            <span>Integration Audit Logs</span>
          </CardTitle>
          <CardDescription>
            API call audit trail for this workspace.
            {total > 0 && ` Showing ${logs.length} of ${total} entries.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">{total.toLocaleString()}</div>
              <div className="text-muted-foreground">Total Calls</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{successRate}%</div>
              <div className="text-muted-foreground">Success Rate</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">{avgDuration}ms</div>
              <div className="text-muted-foreground">Avg Duration</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Filters Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2 text-base">
            <Filter className="h-4 w-4" />
            <span>Filters</span>
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="ml-auto h-7 px-2"
              >
                <X className="h-3 w-3 mr-1" />
                Clear
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {/* Connection Filter */}
            <Select
              value={filters.connectionId || 'all'}
              onValueChange={(value) => {
                setFilters((prev) => ({ ...prev, connectionId: value === 'all' ? '' : value }));
                setCurrentPage(1);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Connection" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Connections</SelectItem>
                {connections.map((conn) => (
                  <SelectItem key={conn.id} value={conn.id}>
                    {conn.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Success/Failure Filter */}
            <Select
              value={filters.success}
              onValueChange={(value) => {
                setFilters((prev) => ({ ...prev, success: value as SuccessFilter }));
                setCurrentPage(1);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="true">Success</SelectItem>
                <SelectItem value="false">Failed</SelectItem>
              </SelectContent>
            </Select>

            {/* Date From */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    'justify-start text-left font-normal w-full',
                    !filters.dateFrom && 'text-muted-foreground'
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {filters.dateFrom ? format(filters.dateFrom, 'MMM d, yyyy') : 'From Date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={filters.dateFrom}
                  onSelect={(date) => {
                    setFilters((prev) => ({ ...prev, dateFrom: date }));
                    setCurrentPage(1);
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>

            {/* Date To */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    'justify-start text-left font-normal w-full',
                    !filters.dateTo && 'text-muted-foreground'
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {filters.dateTo ? format(filters.dateTo, 'MMM d, yyyy') : 'To Date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={filters.dateTo}
                  onSelect={(date) => {
                    setFilters((prev) => ({ ...prev, dateTo: date }));
                    setCurrentPage(1);
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>

            {/* Export */}
            <Button
              onClick={handleExport}
              variant="outline"
              disabled={exporting}
              aria-label="Export CSV"
            >
              {exporting ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Exporting...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  Export CSV
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Table Card */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[180px]">Timestamp</TableHead>
                  <TableHead className="w-[150px]">Tool</TableHead>
                  <TableHead className="w-[120px]">Agent</TableHead>
                  <TableHead className="w-[100px]">Status</TableHead>
                  <TableHead className="w-[100px]">Duration</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      No integration audit logs found
                    </TableCell>
                  </TableRow>
                ) : (
                  logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-mono text-xs">
                        {formatDateTime(log.createdAt)}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-sm">{log.toolName}</span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {log.agentId}
                      </TableCell>
                      <TableCell>
                        {log.success ? (
                          <Badge variant="default">Success</Badge>
                        ) : (
                          <Badge variant="destructive">Failed</Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {log.durationMs != null ? `${log.durationMs}ms` : '-'}
                      </TableCell>
                      <TableCell>
                        <div className="max-w-md truncate text-xs">
                          {log.success
                            ? log.inputSummary || `HTTP ${log.responseCode}`
                            : log.errorMessage || log.errorType || 'Unknown error'}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <div className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages}
                <span className="ml-2">
                  ({(currentPage - 1) * PAGE_SIZE + 1} -{' '}
                  {Math.min(currentPage * PAGE_SIZE, total)} of {total})
                </span>
              </div>
              <div className="flex items-center space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => p - 1)}
                  disabled={!hasPreviousPage || isLoading}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => p + 1)}
                  disabled={!hasNextPage || isLoading}
                  aria-label="Next page"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
