"use client";

import { useEffect, useMemo, useState } from "react";
import { UsersTable } from "@/components/admin/UsersTable";
import { CreateUserForm } from "@/components/admin/CreateUserForm";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  Clock,
  Database,
  MessageCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { StatCard, PageHeader, DataState } from "@/components/admin/kit";
import { useAdminQuery } from "@/hooks/use-admin-query";
import { num } from "@/lib/format";
import { isOnPrem } from "@/lib/deployment-mode";
import type { UsersListResponse } from "@/components/admin/users/types";

const PAGE_SIZE = 25;

type SortOption = "name-asc" | "name-desc" | "lastActive-desc" | "created-desc" | "created-asc" | "tier-desc";

const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "lastActive-desc", label: "Recently active" },
  { value: "created-desc", label: "Newest accounts" },
  { value: "created-asc", label: "Oldest accounts" },
  { value: "tier-desc", label: "Highest tier" },
];

function UsersSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}

export default function AdminUsersPage() {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [sortOption, setSortOption] = useState<SortOption>("name-asc");
  const [dormantOnly, setDormantOnly] = useState(false);
  const [suspendedOnly, setSuspendedOnly] = useState(false);
  const [offset, setOffset] = useState(0);

  // Debounce free-text search before it hits the server.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const url = useMemo(() => {
    const [sort, dir] = sortOption.split("-") as [string, string];
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      sort,
      dir,
    });
    if (query) params.set("q", query);
    if (dormantOnly) params.set("dormant", "true");
    if (suspendedOnly) params.set("suspended", "true");
    return `/api/admin/users?${params.toString()}`;
  }, [query, sortOption, dormantOnly, suspendedOnly, offset]);

  const { data, isLoading, isFetching, error, refetch } = useAdminQuery<UsersListResponse>(url);

  const summary = data?.summary ?? null;
  const total = data?.total ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Accounts, activity, subscriptions, and admin controls."
        actions={
          <Button variant="outline" size="sm" onClick={refetch} disabled={isFetching}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Total Users" value={summary ? num(summary.totalUsers) : "—"} icon={Users} isLoading={isLoading} />
        <StatCard label="Verified" value={summary ? num(summary.verifiedUsers) : "—"} icon={ShieldCheck} tone="positive" isLoading={isLoading} />
        <StatCard label="Dormant (30d+)" value={summary ? num(summary.dormantUsers) : "—"} icon={Clock} tone="warning" isLoading={isLoading} />
        <StatCard label="Suspended" value={summary ? num(summary.suspendedUsers) : "—"} icon={Ban} tone={summary && summary.suspendedUsers > 0 ? "negative" : "default"} isLoading={isLoading} />
        <StatCard label="Total Drives" value={summary ? num(summary.totalDrives) : "—"} icon={Database} isLoading={isLoading} />
        <StatCard label="Total Messages" value={summary ? num(summary.totalMessages) : "—"} icon={MessageCircle} isLoading={isLoading} />
      </div>

      {isOnPrem() && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <UserPlus className="h-5 w-5" />
              <span>Create User Account</span>
            </CardTitle>
            <CardDescription>
              Create staff accounts for your team. Users cannot self-register on this deployment.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateUserForm onSuccess={refetch} />
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, or AI provider..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={sortOption} onValueChange={(v) => { setSortOption(v as SortOption); setOffset(0); }}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={dormantOnly ? "default" : "outline"}
          size="sm"
          onClick={() => { setDormantOnly(v => !v); setOffset(0); }}
        >
          <Clock className="mr-1.5 h-4 w-4" />
          Dormant{summary ? ` (${num(summary.dormantUsers)})` : ""}
        </Button>
        <Button
          variant={suspendedOnly ? "default" : "outline"}
          size="sm"
          onClick={() => { setSuspendedOnly(v => !v); setOffset(0); }}
        >
          <Ban className="mr-1.5 h-4 w-4" />
          Suspended{summary ? ` (${num(summary.suspendedUsers)})` : ""}
        </Button>
      </div>

      <DataState
        isLoading={isLoading}
        error={error}
        isEmpty={!!data && data.users.length === 0}
        emptyMessage="No users match the current filters."
        onRetry={refetch}
        skeleton={<UsersSkeleton />}
      >
        {data && (
          <>
            <UsersTable users={data.users} onActionComplete={refetch} />

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <p className="text-sm text-muted-foreground">
                Showing {num(pageStart)}–{num(pageEnd)} of {num(total)} user{total === 1 ? "" : "s"}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  disabled={offset === 0 || isFetching}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={offset + PAGE_SIZE >= total || isFetching}
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </DataState>
    </div>
  );
}
