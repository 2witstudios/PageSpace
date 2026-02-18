'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
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
import { Clock, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { useIntegrationAuditLogs, useDriveConnections } from '@/hooks/useIntegrations';

interface IntegrationAuditLogProps {
  driveId: string;
}

const PAGE_SIZE = 20;

const formatTimestamp = (ts: string) => {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export function IntegrationAuditLog({ driveId }: IntegrationAuditLogProps) {
  const [offset, setOffset] = useState(0);
  const [connectionFilter, setConnectionFilter] = useState<string>('all');
  const [successFilter, setSuccessFilter] = useState<string>('all');

  const { connections } = useDriveConnections(driveId);

  const params: {
    limit: number;
    offset: number;
    connectionId?: string;
    success?: boolean;
  } = {
    limit: PAGE_SIZE,
    offset,
  };

  if (connectionFilter !== 'all') {
    params.connectionId = connectionFilter;
  }
  if (successFilter !== 'all') {
    params.success = successFilter === 'true';
  }

  const { logs, total, isLoading, error } = useIntegrationAuditLogs(driveId, params);

  const connectionNameMap = useMemo(
    () => new Map(connections.map((c) => [c.id, c.name])),
    [connections]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="w-5 h-5" />
          Integration Activity
        </CardTitle>
        <CardDescription>
          Audit log of external API calls made by AI agents in this drive.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Filters */}
        <div className="flex items-center gap-3 mb-4">
          <Select
            value={connectionFilter}
            onValueChange={(v) => { setConnectionFilter(v); setOffset(0); }}
          >
            <SelectTrigger className="w-[180px] h-8 text-xs">
              <SelectValue placeholder="All connections" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All connections</SelectItem>
              {connections.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={successFilter}
            onValueChange={(v) => { setSuccessFilter(v); setOffset(0); }}
          >
            <SelectTrigger className="w-[120px] h-8 text-xs">
              <SelectValue placeholder="All status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="true">Success</SelectItem>
              <SelectItem value="false">Failed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 p-4 text-sm text-destructive bg-destructive/10 rounded-lg">
            <AlertCircle className="h-4 w-4" />
            <span>Failed to load audit logs</span>
          </div>
        ) : logs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No integration activity recorded.
          </p>
        ) : (
          <>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Timestamp</TableHead>
                    <TableHead className="text-xs">Tool</TableHead>
                    <TableHead className="text-xs">Connection</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs text-right">Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(log.createdAt)}
                      </TableCell>
                      <TableCell className="text-xs font-mono">{log.toolName}</TableCell>
                      <TableCell className="text-xs">
                        {connectionNameMap.get(log.connectionId) ?? log.connectionId.slice(0, 8)}
                      </TableCell>
                      <TableCell>
                        {log.success ? (
                          <Badge variant="default" className="text-[10px] px-1.5 py-0">
                            {log.responseCode ?? 'OK'}
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                            {log.errorType ?? 'Error'}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-right text-muted-foreground">
                        {log.durationMs != null ? `${log.durationMs}ms` : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between mt-3">
              <p className="text-xs text-muted-foreground">
                Showing {offset + 1}-{Math.min(offset + logs.length, total)} of {total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  <ChevronLeft className="h-3 w-3 mr-1" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                  <ChevronRight className="h-3 w-3 ml-1" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
