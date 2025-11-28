"use client";

import { useState, useEffect } from "react";
import { SchemaTable } from "@/components/admin/SchemaTable";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Database, AlertCircle } from "lucide-react";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";

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

export default function AdminTablesPage() {
  const [tables, setTables] = useState<TableData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchSchema() {
      try {
        const response = await fetchWithAuth('/api/admin/schema');
        if (!response.ok) {
          throw new Error('Failed to fetch schema data');
        }
        const data = await response.json();
        setTables(data.tables);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    }

    fetchSchema();
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96" />
          </CardHeader>
        </Card>
        
        {[...Array(3)].map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-4 w-32" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Error loading schema data: {error}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Database className="h-5 w-5" />
            <span>Database Schema Overview</span>
          </CardTitle>
          <CardDescription>
            Explore your database tables, columns, relationships, and constraints. 
            This view shows {tables.length} tables with detailed column information and foreign key relationships.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">{tables.length}</div>
              <div className="text-muted-foreground">Tables</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">
                {tables.reduce((sum, table) => sum + table.columns.length, 0)}
              </div>
              <div className="text-muted-foreground">Columns</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">
                {tables.reduce((sum, table) => sum + table.constraints.filter((c: ConstraintData) => c.type === 'FOREIGN KEY').length, 0)}
              </div>
              <div className="text-muted-foreground">Foreign Keys</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">
                {tables.reduce((sum, table) => sum + table.indexes.length, 0)}
              </div>
              <div className="text-muted-foreground">Indexes</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <SchemaTable tables={tables} />
    </div>
  );
}