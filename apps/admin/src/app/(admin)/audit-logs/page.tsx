"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  User,
  Database,
  Filter,
  X,
  Bot,
  Hash,
  RefreshCw,
} from "lucide-react";
import { StatCard, PageHeader, DataState } from "@/components/admin/kit";
import { useAdminQuery } from "@/hooks/use-admin-query";
import { num } from "@/lib/format";
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
  aiGeneratedTotal: number;
  hashChainTotal: number;
}

interface AuditLogsResponse {
  logs: AuditLogEntry[];
  pagination: Pagination;
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

const SEARCH_DEBOUNCE_MS = 400;

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

function buildFilterParams(filters: FiltersState): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.userId) params.set("userId", filters.userId);
  if (filters.operation) params.set("operation", filters.operation);
  if (filters.resourceType) params.set("resourceType", filters.resourceType);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom.toISOString());
  if (filters.dateTo) params.set("dateTo", filters.dateTo.toISOString());
  if (filters.search) params.set("search", filters.search);
  return params;
}

export default function AdminAuditLogsPage() {
  const [filters, setFilters] = useState<FiltersState>({
    userId: "",
    operation: "",
    resourceType: "",
    dateFrom: undefined,
    dateTo: undefined,
    search: "",
  });
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced auto-apply for the search input; all other filters apply immediately.
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setFilters((prev) => (prev.search === searchInput ? prev : { ...prev, search: searchInput }));
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchInput]);

  const url = useMemo(() => {
    const params = buildFilterParams(filters);
    params.set("page", page.toString());
    params.set("limit", "50");
    return `/api/admin/audit-logs?${params.toString()}`;
  }, [filters, page]);

  const { data, isLoading, error, refetch } = useAdminQuery<AuditLogsResponse>(url);

  const logs = data?.logs ?? [];
  const pagination = data?.pagination ?? null;

  const updateFilters = (update: Partial<FiltersState>) => {
    setFilters((prev) => ({ ...prev, ...update }));
    setPage(1);
  };

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const params = buildFilterParams(filters);
      const response = await fetchWithAuth(`/api/admin/audit-logs/export?${params.toString()}`);

      if (!response.ok) {
        throw new Error("Failed to export audit logs");
      }

      // Get the blob and create download
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `audit-logs-${format(new Date(), "yyyy-MM-dd-HHmmss")}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(blobUrl);
      document.body.removeChild(a);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
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
    setPage(1);
  };

  const hasActiveFilters = Boolean(
    filters.userId ||
    filters.operation ||
    filters.resourceType ||
    filters.dateFrom ||
    filters.dateTo ||
    filters.search
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Logs"
        description="Tamper-evident audit trail of all system activities."
        actions={
          <Button
            onClick={handleExport}
            variant="outline"
            className="h-10"
            disabled={exporting}
          >
            {exporting ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </>
            )}
          </Button>
        }
      />

      {exportError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{exportError}</AlertDescription>
        </Alert>
      )}

      {/* Overview stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Total entries"
          value={pagination ? num(pagination.totalCount) : "—"}
          icon={FileText}
          isLoading={isLoading}
        />
        <StatCard
          label="Total pages"
          value={pagination ? num(pagination.totalPages) : "—"}
          icon={Database}
          isLoading={isLoading}
        />
        <StatCard
          label="AI generated"
          value={pagination ? num(pagination.aiGeneratedTotal) : "—"}
          icon={Bot}
          isLoading={isLoading}
        />
        <StatCard
          label="Hash chain"
          value={pagination ? num(pagination.hashChainTotal) : "—"}
          icon={Hash}
          isLoading={isLoading}
        />
      </div>

      {/* Filters Card — all filters auto-apply (search is debounced) */}
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
                className="ml-auto h-10 px-3"
              >
                <X className="mr-1 h-3 w-3" />
                Clear
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {/* Search (auto-applies after a short pause) */}
            <div className="relative xl:col-span-2">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform text-muted-foreground" />
              <Input
                placeholder="Search by title, email, or ID..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="h-10 pl-10"
              />
            </div>

            {/* Operation Filter */}
            <Select
              value={filters.operation}
              onValueChange={(value) => updateFilters({ operation: value === "all" ? "" : value })}
            >
              <SelectTrigger className="h-10 w-full">
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
              onValueChange={(value) => updateFilters({ resourceType: value === "all" ? "" : value })}
            >
              <SelectTrigger className="h-10 w-full">
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
                    "h-10 w-full justify-start text-left font-normal",
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
                  onSelect={(date: Date | undefined) => updateFilters({ dateFrom: date })}
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
                    "h-10 w-full justify-start text-left font-normal",
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
                  onSelect={(date: Date | undefined) => updateFilters({ dateTo: date })}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>
        </CardContent>
      </Card>

      {/* Logs Table */}
      <Card>
        <CardContent className="p-0">
          <DataState
            isLoading={isLoading}
            error={error}
            isEmpty={logs.length === 0}
            emptyMessage="No audit logs found matching your criteria."
            onRetry={refetch}
            skeleton={
              <div className="space-y-2 p-4">
                {[...Array(8)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            }
          >
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
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="font-mono text-xs">
                      {formatDateTime(log.timestamp)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">
                          {log.actorDisplayName || "Unknown"}
                          {log.isAiGenerated && (
                            <Badge variant="outline" className="ml-2 text-xs">
                              <Bot className="mr-1 h-3 w-3" />
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
                          <span className="ml-2 text-xs text-muted-foreground">
                            ({log.updatedFields.length} field{log.updatedFields.length !== 1 ? "s" : ""})
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      {log.logHash ? (
                        <Badge variant="outline" className="text-success">
                          <Hash className="h-3 w-3" />
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Pagination */}
            {pagination && pagination.totalPages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
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
                    className="h-10"
                    onClick={() => setPage(pagination.page - 1)}
                    disabled={!pagination.hasPreviousPage}
                  >
                    <ChevronLeft className="mr-1 h-4 w-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-10"
                    onClick={() => setPage(pagination.page + 1)}
                    disabled={!pagination.hasNextPage}
                  >
                    Next
                    <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </DataState>
        </CardContent>
      </Card>
    </div>
  );
}
