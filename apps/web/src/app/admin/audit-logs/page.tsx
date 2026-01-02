"use client";

import { useState, useEffect, useCallback } from "react";
import { format } from "date-fns";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  Search,
  FileText,
  Download,
  CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Shield,
  Activity,
  User,
  Database,
  Filter,
  X,
  Bot,
  Hash,
  RefreshCw,
} from "lucide-react";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import { cn } from "@/lib/utils";

// Activity log data types based on API response
interface AuditLogEntry {
  id: string;
  timestamp: string;
  userId: string | null;
  actorEmail: string;
  actorDisplayName: string | null;
  isAiGenerated: boolean;
  aiProvider: string | null;
  aiModel: string | null;
  aiConversationId: string | null;
  operation: string;
  resourceType: string;
  resourceId: string;
  resourceTitle: string | null;
  driveId: string | null;
  pageId: string | null;
  updatedFields: string[] | null;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  isArchived: boolean;
  previousLogHash: string | null;
  logHash: string | null;
  chainSeed: string | null;
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
}

interface Pagination {
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

interface FiltersState {
  userId: string;
  operation: string;
  resourceType: string;
  dateFrom: Date | undefined;
  dateTo: Date | undefined;
  search: string;
}

// Operation enum values from the schema
const OPERATIONS = [
  "create",
  "update",
  "delete",
  "restore",
  "reorder",
  "permission_grant",
  "permission_update",
  "permission_revoke",
  "trash",
  "move",
  "agent_config_update",
  "member_add",
  "member_remove",
  "member_role_change",
  "login",
  "logout",
  "signup",
  "password_change",
  "email_change",
  "token_create",
  "token_revoke",
  "upload",
  "convert",
  "account_delete",
  "profile_update",
  "avatar_update",
  "message_update",
  "message_delete",
  "role_reorder",
  "ownership_transfer",
  "rollback",
  "conversation_undo",
  "conversation_undo_with_changes",
];

// Resource type enum values from the schema
const RESOURCE_TYPES = [
  "page",
  "drive",
  "permission",
  "agent",
  "user",
  "member",
  "role",
  "file",
  "token",
  "device",
  "message",
  "conversation",
];

function formatDateTime(dateString: string | null) {
  if (!dateString) return "N/A";
  return format(new Date(dateString), "MMM d, yyyy HH:mm:ss");
}

function formatDateShort(dateString: string | null) {
  if (!dateString) return "N/A";
  return format(new Date(dateString), "MMM d, yyyy");
}

function getOperationColor(operation: string): "default" | "secondary" | "destructive" | "outline" {
  if (operation.includes("delete") || operation.includes("revoke") || operation === "trash") {
    return "destructive";
  }
  if (operation.includes("create") || operation === "signup" || operation.includes("grant")) {
    return "default";
  }
  if (operation.includes("update") || operation.includes("change")) {
    return "secondary";
  }
  return "outline";
}

function getResourceIcon(resourceType: string) {
  switch (resourceType) {
    case "user":
    case "member":
      return <User className="h-3 w-3" />;
    case "page":
    case "drive":
      return <FileText className="h-3 w-3" />;
    case "permission":
    case "role":
      return <Shield className="h-3 w-3" />;
    case "agent":
    case "conversation":
      return <Bot className="h-3 w-3" />;
    default:
      return <Database className="h-3 w-3" />;
  }
}

export default function AdminAuditLogsPage() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState<FiltersState>({
    userId: "",
    operation: "",
    resourceType: "",
    dateFrom: undefined,
    dateTo: undefined,
    search: "",
  });
  const [searchInput, setSearchInput] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  const fetchLogs = useCallback(async (page: number = 1) => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      params.set("limit", "50");

      if (filters.userId) params.set("userId", filters.userId);
      if (filters.operation) params.set("operation", filters.operation);
      if (filters.resourceType) params.set("resourceType", filters.resourceType);
      if (filters.dateFrom) params.set("dateFrom", filters.dateFrom.toISOString());
      if (filters.dateTo) params.set("dateTo", filters.dateTo.toISOString());
      if (filters.search) params.set("search", filters.search);

      const response = await fetchWithAuth(`/api/admin/audit-logs?${params.toString()}`);

      if (!response.ok) {
        throw new Error("Failed to fetch audit logs");
      }

      const data = await response.json();
      setLogs(data.logs);
      setPagination(data.pagination);
      setCurrentPage(data.pagination.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchLogs(1);
  }, [fetchLogs]);

  const handleSearch = () => {
    setFilters(prev => ({ ...prev, search: searchInput }));
    setCurrentPage(1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (filters.userId) params.set("userId", filters.userId);
      if (filters.operation) params.set("operation", filters.operation);
      if (filters.resourceType) params.set("resourceType", filters.resourceType);
      if (filters.dateFrom) params.set("dateFrom", filters.dateFrom.toISOString());
      if (filters.dateTo) params.set("dateTo", filters.dateTo.toISOString());
      if (filters.search) params.set("search", filters.search);

      const response = await fetchWithAuth(`/api/admin/audit-logs/export?${params.toString()}`);

      if (!response.ok) {
        throw new Error("Failed to export audit logs");
      }

      // Get the blob and create download
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-logs-${format(new Date(), "yyyy-MM-dd-HHmmss")}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const clearFilters = () => {
    setFilters({
      userId: "",
      operation: "",
      resourceType: "",
      dateFrom: undefined,
      dateTo: undefined,
      search: "",
    });
    setSearchInput("");
    setCurrentPage(1);
  };

  const hasActiveFilters =
    filters.userId ||
    filters.operation ||
    filters.resourceType ||
    filters.dateFrom ||
    filters.dateTo ||
    filters.search;

  if (loading && !logs.length) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96" />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="text-center">
                  <Skeleton className="h-8 w-16 mx-auto mb-2" />
                  <Skeleton className="h-4 w-20 mx-auto" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center space-x-4">
              <Skeleton className="h-10 w-full max-w-sm" />
              <Skeleton className="h-10 w-32" />
            </div>
          </CardHeader>
          <CardContent>
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full mb-2" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error && !logs.length) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Error loading audit logs: {error}
        </AlertDescription>
      </Alert>
    );
  }

  // Calculate stats from pagination
  const totalLogs = pagination?.totalCount || 0;
  const aiGeneratedCount = logs.filter(log => log.isAiGenerated).length;
  const hasHashChain = logs.filter(log => log.logHash).length;

  return (
    <div className="space-y-6">
      {/* Overview Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Activity className="h-5 w-5" />
            <span>Audit Logs</span>
          </CardTitle>
          <CardDescription>
            Comprehensive audit trail of all system activities.
            {pagination && ` Showing ${logs.length} of ${pagination.totalCount} entries.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">{totalLogs.toLocaleString()}</div>
              <div className="text-muted-foreground flex items-center justify-center">
                <FileText className="h-4 w-4 mr-1" />
                Total Entries
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">{pagination?.totalPages || 0}</div>
              <div className="text-muted-foreground flex items-center justify-center">
                <Database className="h-4 w-4 mr-1" />
                Total Pages
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-600">{aiGeneratedCount}</div>
              <div className="text-muted-foreground flex items-center justify-center">
                <Bot className="h-4 w-4 mr-1" />
                AI Generated (page)
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{hasHashChain}</div>
              <div className="text-muted-foreground flex items-center justify-center">
                <Hash className="h-4 w-4 mr-1" />
                Hash Chain (page)
              </div>
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {/* Search */}
            <div className="relative xl:col-span-2">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by title, email, or ID..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={handleKeyDown}
                className="pl-10"
              />
            </div>

            {/* Operation Filter */}
            <Select
              value={filters.operation}
              onValueChange={(value) => setFilters(prev => ({ ...prev, operation: value === "all" ? "" : value }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Operation" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Operations</SelectItem>
                {OPERATIONS.map((op) => (
                  <SelectItem key={op} value={op}>
                    {op.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Resource Type Filter */}
            <Select
              value={filters.resourceType}
              onValueChange={(value) => setFilters(prev => ({ ...prev, resourceType: value === "all" ? "" : value }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Resource Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Resources</SelectItem>
                {RESOURCE_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Date From */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "justify-start text-left font-normal w-full",
                    !filters.dateFrom && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {filters.dateFrom ? formatDateShort(filters.dateFrom.toISOString()) : "From Date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={filters.dateFrom}
                  onSelect={(date) => setFilters(prev => ({ ...prev, dateFrom: date }))}
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
                    "justify-start text-left font-normal w-full",
                    !filters.dateTo && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {filters.dateTo ? formatDateShort(filters.dateTo.toISOString()) : "To Date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={filters.dateTo}
                  onSelect={(date) => setFilters(prev => ({ ...prev, dateTo: date }))}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex gap-2 mt-4">
            <Button onClick={handleSearch} size="sm">
              <Search className="h-4 w-4 mr-2" />
              Apply Filters
            </Button>
            <Button
              onClick={handleExport}
              variant="outline"
              size="sm"
              disabled={exporting}
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

      {/* Logs Table */}
      <Card>
        <CardContent className="p-0">
          {error && (
            <Alert variant="destructive" className="m-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[180px]">Timestamp</TableHead>
                  <TableHead className="w-[180px]">Actor</TableHead>
                  <TableHead className="w-[140px]">Operation</TableHead>
                  <TableHead className="w-[120px]">Resource</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead className="w-[80px] text-center">Verified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      No audit logs found matching your criteria
                    </TableCell>
                  </TableRow>
                ) : (
                  logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-mono text-xs">
                        {formatDateTime(log.timestamp)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium text-sm">
                            {log.actorDisplayName || "Unknown"}
                            {log.isAiGenerated && (
                              <Badge variant="outline" className="ml-2 text-xs">
                                <Bot className="h-3 w-3 mr-1" />
                                AI
                              </Badge>
                            )}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {log.actorEmail}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getOperationColor(log.operation)}>
                          {log.operation.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center space-x-1">
                          {getResourceIcon(log.resourceType)}
                          <span className="capitalize">{log.resourceType}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="max-w-md truncate">
                          {log.resourceTitle || log.resourceId}
                          {log.updatedFields && log.updatedFields.length > 0 && (
                            <span className="text-xs text-muted-foreground ml-2">
                              ({log.updatedFields.length} field{log.updatedFields.length !== 1 ? "s" : ""})
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        {log.logHash ? (
                          <Badge variant="outline" className="text-green-600">
                            <Hash className="h-3 w-3" />
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <div className="text-sm text-muted-foreground">
                Page {pagination.page} of {pagination.totalPages}
                <span className="ml-2">
                  ({((pagination.page - 1) * pagination.limit) + 1} - {Math.min(pagination.page * pagination.limit, pagination.totalCount)} of {pagination.totalCount})
                </span>
              </div>
              <div className="flex items-center space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fetchLogs(currentPage - 1)}
                  disabled={!pagination.hasPreviousPage || loading}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fetchLogs(currentPage + 1)}
                  disabled={!pagination.hasNextPage || loading}
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
