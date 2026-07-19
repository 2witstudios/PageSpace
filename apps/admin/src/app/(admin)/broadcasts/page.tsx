"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader, DataState } from "@/components/admin/kit";
import { StatusBadge } from "@/components/admin/broadcasts/status-badge";
import { useAdminQuery } from "@/hooks/use-admin-query";
import { num } from "@/lib/format";
import type { BroadcastsListResponse } from "@/components/admin/broadcasts/types";

function BroadcastsSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export default function BroadcastsPage() {
  const router = useRouter();
  const { data, isLoading, isFetching, error, refetch } = useAdminQuery<BroadcastsListResponse>(
    "/api/admin/broadcasts",
    { refreshInterval: 15000 },
  );

  const broadcasts = data?.broadcasts ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Broadcasts"
        description="Compose, target, and send email broadcasts to your users."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refetch} disabled={isFetching}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => router.push("/broadcasts/new")}>
              <Plus className="mr-1.5 h-4 w-4" />
              New broadcast
            </Button>
          </>
        }
      />

      <DataState
        isLoading={isLoading}
        error={error}
        isEmpty={!!data && broadcasts.length === 0}
        emptyMessage="No broadcasts yet. Start with a dry run to preview an audience and email."
        onRetry={refetch}
        skeleton={<BroadcastsSkeleton />}
        hasData={!!data}
      >
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Engine</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Skipped</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Targeted</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {broadcasts.map((broadcast) => (
                <TableRow
                  key={broadcast.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/broadcasts/${broadcast.id}`)}
                >
                  <TableCell className="max-w-[320px] truncate font-medium">
                    <Link href={`/broadcasts/${broadcast.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                      {broadcast.subject || "(untitled)"}
                    </Link>
                    {broadcast.dryRun && (
                      <Badge variant="outline" className="ml-2 align-middle">
                        Dry run
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={broadcast.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {broadcast.engine === "transactional" ? "Transactional" : "Marketing (Resend)"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{num(broadcast.sentCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(broadcast.skippedCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(broadcast.failedCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(broadcast.totalTargeted)}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {new Date(broadcast.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DataState>
    </div>
  );
}
