"use client";

import { useMemo, useRef, useState } from "react";
import { ContactSubmissionsTable } from "@/components/admin/ContactSubmissionsTable";
import { MessageSquare, Calendar, TrendingUp, Users } from "lucide-react";
import { StatCard, PageHeader } from "@/components/admin/kit";
import { useAdminQuery } from "@/hooks/use-admin-query";
import { num } from "@/lib/format";

interface RegisteredUser {
  id: string;
  subscriptionTier: string | null;
}

interface ContactSubmission {
  id: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  createdAt: string;
  resolvedAt: string | null;
  registeredUser: RegisteredUser | null;
}

interface PaginationData {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

interface StatsData {
  todayCount: number;
  weekCount: number;
  uniqueEmailCount: number;
}

interface ApiResponse {
  submissions: ContactSubmission[];
  pagination: PaginationData;
  stats: StatsData;
  meta: {
    searchTerm: string;
    sortBy: string;
    sortOrder: string;
    statusFilter: string;
  };
}

const SEARCH_DEBOUNCE_MS = 400;

export default function AdminSupportPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "closed">("all");
  const [page, setPage] = useState(1);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const url = useMemo(() => {
    const params = new URLSearchParams({
      search: searchTerm,
      sortBy,
      sortOrder,
      status: statusFilter,
      page: page.toString(),
      pageSize: "25",
    });
    return `/api/admin/contact?${params}`;
  }, [searchTerm, sortBy, sortOrder, statusFilter, page]);

  const { data, isLoading, error, refetch } = useAdminQuery<ApiResponse>(url);

  const handleSearch = (newSearchTerm: string) => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearchTerm(newSearchTerm);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
  };

  const handleSort = (newSortBy: string, newSortOrder: "asc" | "desc") => {
    setSortBy(newSortBy);
    setSortOrder(newSortOrder);
    setPage(1);
  };

  const handleStatusFilter = (status: "all" | "open" | "closed") => {
    setStatusFilter(status);
    setPage(1);
  };

  const stats = data?.stats ?? null;
  const pagination = data?.pagination ?? {
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 0,
    hasNextPage: false,
    hasPrevPage: false,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Support"
        description="Monitor and respond to contact form submissions from your website."
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Total submissions"
          value={data ? num(pagination.total) : "—"}
          icon={MessageSquare}
          isLoading={isLoading}
        />
        <StatCard
          label="Today"
          value={stats ? num(stats.todayCount) : "—"}
          icon={Calendar}
          isLoading={isLoading}
        />
        <StatCard
          label="This week"
          value={stats ? num(stats.weekCount) : "—"}
          icon={TrendingUp}
          isLoading={isLoading}
        />
        <StatCard
          label="Unique contacts"
          value={stats ? num(stats.uniqueEmailCount) : "—"}
          icon={Users}
          isLoading={isLoading}
        />
      </div>

      <ContactSubmissionsTable
        submissions={data?.submissions ?? []}
        pagination={pagination}
        onSearch={handleSearch}
        onPageChange={handlePageChange}
        onSort={handleSort}
        onStatusFilter={handleStatusFilter}
        statusFilter={statusFilter}
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        hasData={!!data}
      />
    </div>
  );
}
