"use client";

import { SchemaTable } from "@/components/admin/SchemaTable";
import { Skeleton } from "@/components/ui/skeleton";
import { Database, Columns3, Link2, ListOrdered } from "lucide-react";
import { StatCard, PageHeader, DataState } from "@/components/admin/kit";
import { useAdminQuery } from "@/hooks/use-admin-query";
import { num } from "@/lib/format";

interface ColumnData {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  position: number;
  comment: string | null;
}

interface ConstraintData {
  name: string;
  type: string;
  column: string;
  foreignTable: string | null;
  foreignColumn: string | null;
}

interface IndexData {
  name: string;
  definition: string;
}

interface TableData {
  name: string;
  type: string;
  comment: string | null;
  columns: ColumnData[];
  constraints: ConstraintData[];
  indexes: IndexData[];
}

interface SchemaResponse {
  tables: TableData[];
}

export default function AdminTablesPage() {
  const { data, isLoading, error, refetch } = useAdminQuery<SchemaResponse>("/api/admin/schema");

  const tables = data?.tables ?? [];
  const columnCount = tables.reduce((sum, table) => sum + table.columns.length, 0);
  const foreignKeyCount = tables.reduce(
    (sum, table) => sum + table.constraints.filter((c) => c.type === "FOREIGN KEY").length,
    0
  );
  const indexCount = tables.reduce((sum, table) => sum + table.indexes.length, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Database Schema"
        description="Explore tables, columns, relationships, and constraints (metadata only)."
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Tables"
          value={data ? num(tables.length) : "—"}
          icon={Database}
          isLoading={isLoading}
        />
        <StatCard
          label="Columns"
          value={data ? num(columnCount) : "—"}
          icon={Columns3}
          isLoading={isLoading}
        />
        <StatCard
          label="Foreign keys"
          value={data ? num(foreignKeyCount) : "—"}
          icon={Link2}
          isLoading={isLoading}
        />
        <StatCard
          label="Indexes"
          value={data ? num(indexCount) : "—"}
          icon={ListOrdered}
          isLoading={isLoading}
        />
      </div>

      <DataState
        isLoading={isLoading}
        error={error}
        isEmpty={tables.length === 0}
        emptyMessage="No tables found."
        onRetry={refetch}
        skeleton={
          <div className="space-y-4">
            <Skeleton className="h-10 w-full" />
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        }
      >
        <SchemaTable tables={tables} />
      </DataState>
    </div>
  );
}
