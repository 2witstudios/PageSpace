'use client';

import { useState, useMemo } from 'react';
import { Button } from '@/retained/components/ui/button';
import { Skeleton } from '@/retained/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/retained/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/retained/components/ui/table';
import { ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { useIntegrationAuditLogs, useDriveConnections } from '@/retained/hooks/useIntegrations';
import { SettingsSection } from '@/ui/settings/settings-screen/settings-screen';

interface IntegrationAuditLogProps {
  driveId: string;
}

const PAGE_SIZE = 20;

export type AuditConnectionFilter = string | 'all';
export type AuditStatusFilter = 'all' | 'true' | 'false';

/**
 * The audit route's query for the Connection and Status filters at a page offset. 'all' sends
 * no filter; Status is 'true' (Success) or 'false' (Failed).
 */
export function auditQuery(connection: AuditConnectionFilter, status: AuditStatusFilter, offset: number) {
  return {
    limit: PAGE_SIZE,
    offset,
    ...(connection === 'all' ? {} : { connectionId: connection }),
    ...(status === 'all' ? {} : { success: status === 'true' }),
  };
}

const formatTimestamp = (ts: string) => {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const headClass = 'px-3 py-2 text-xs font-medium text-muted-foreground';
const cellClass = 'border-t border-border px-3 py-2';

export function IntegrationAuditLog({ driveId }: IntegrationAuditLogProps) {
  const [offset, setOffset] = useState(0);
  const [connectionFilter, setConnectionFilter] = useState<AuditConnectionFilter>('all');
  const [successFilter, setSuccessFilter] = useState<AuditStatusFilter>('all');

  const { connections } = useDriveConnections(driveId);

  const { logs, total, isLoading, error } = useIntegrationAuditLogs(
    driveId,
    auditQuery(connectionFilter, successFilter, offset)
  );

  const connectionNameMap = useMemo(
    () => new Map(connections.map((c) => [c.id, c.name])),
    [connections]
  );

  return (
    <SettingsSection
      title="Audit log"
      description="External API calls made by AI agents in this drive."
      actions={
        <>
          <Select
            value={connectionFilter}
            onValueChange={(v) => { setConnectionFilter(v); setOffset(0); }}
          >
            <SelectTrigger aria-label="Connection" className="h-8 w-[180px] text-xs">
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
            onValueChange={(v) => { setSuccessFilter(v as AuditStatusFilter); setOffset(0); }}
          >
            <SelectTrigger aria-label="Status" className="h-8 w-[120px] text-xs">
              <SelectValue placeholder="All status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="true">Success</SelectItem>
              <SelectItem value="false">Failed</SelectItem>
            </SelectContent>
          </Select>
        </>
      }
    >
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
        <p className="py-8 text-center text-sm text-muted-foreground">No integration activity recorded.</p>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow className="bg-tint hover:bg-tint">
                  <TableHead className={headClass}>Timestamp</TableHead>
                  <TableHead className={headClass}>Tool</TableHead>
                  <TableHead className={headClass}>Connection</TableHead>
                  <TableHead className={headClass}>Status</TableHead>
                  <TableHead className={`${headClass} text-right`}>Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id} className="hover:bg-transparent">
                    <TableCell className={`${cellClass} whitespace-nowrap text-xs text-muted-foreground`}>
                      {formatTimestamp(log.createdAt)}
                    </TableCell>
                    <TableCell className={`${cellClass} font-mono text-xs`}>{log.toolName}</TableCell>
                    <TableCell className={`${cellClass} text-xs`}>
                      {connectionNameMap.get(log.connectionId) ?? log.connectionId.slice(0, 8)}
                    </TableCell>
                    <TableCell className={cellClass}>
                      <span
                        className={
                          log.success
                            ? 'inline-flex h-5 items-center rounded-full bg-status-success/15 px-2 text-[11.5px] font-medium text-status-success'
                            : 'inline-flex h-5 items-center rounded-full bg-status-danger/15 px-2 text-[11.5px] font-medium text-status-danger'
                        }
                      >
                        {log.success ? 'Success' : 'Failed'}
                      </span>
                    </TableCell>
                    <TableCell className={`${cellClass} text-right font-mono text-xs text-muted-foreground`}>
                      {log.durationMs != null ? `${log.durationMs} ms` : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="mt-3 flex items-center justify-between">
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
                <ChevronLeft className="mr-1 h-3 w-3" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
                <ChevronRight className="ml-1 h-3 w-3" />
              </Button>
            </div>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
