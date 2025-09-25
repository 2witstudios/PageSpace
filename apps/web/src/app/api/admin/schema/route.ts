import { db, sql } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { verifyAdminAuth } from '@/lib/auth';

export async function GET(request: Request) {
  try {
    // Verify user is authenticated and is an admin
    const adminUser = await verifyAdminAuth(request);
    
    if (!adminUser) {
      return Response.json(
        { error: 'Unauthorized: Admin access required' },
        { status: 403 }
      );
    }
    // Get all table information from PostgreSQL information_schema
    const tablesQuery = sql`
      SELECT 
        t.table_name,
        t.table_type,
        obj_description(c.oid) as table_comment
      FROM information_schema.tables t
      LEFT JOIN pg_class c ON c.relname = t.table_name
      WHERE t.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name;
    `;

    const columnsQuery = sql`
      SELECT 
        c.table_name,
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        c.character_maximum_length,
        c.numeric_precision,
        c.numeric_scale,
        c.ordinal_position,
        col_description(pgc.oid, c.ordinal_position) as column_comment
      FROM information_schema.columns c
      LEFT JOIN pg_class pgc ON pgc.relname = c.table_name
      WHERE c.table_schema = 'public'
      ORDER BY c.table_name, c.ordinal_position;
    `;

    const constraintsQuery = sql`
      SELECT 
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu 
        ON tc.constraint_name = kcu.constraint_name
      LEFT JOIN information_schema.constraint_column_usage ccu 
        ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_schema = 'public'
      ORDER BY tc.table_name, tc.constraint_name;
    `;

    const indexesQuery = sql`
      SELECT 
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM pg_indexes 
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname;
    `;

    const [tables, columns, constraints, indexes] = await Promise.all([
      db.execute(tablesQuery),
      db.execute(columnsQuery),
      db.execute(constraintsQuery),
      db.execute(indexesQuery)
    ]);

    interface TableRow {
      table_name: string;
      table_type: string;
      table_comment: string | null;
    }

    interface ColumnRow {
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
      ordinal_position: number;
      column_comment: string | null;
    }

    interface ConstraintRow {
      table_name: string;
      constraint_name: string;
      constraint_type: string;
      column_name: string;
      foreign_table_name: string | null;
      foreign_column_name: string | null;
    }

    interface IndexRow {
      tablename: string;
      indexname: string;
      indexdef: string;
    }

    // Group data by table
    const schemaData = (tables.rows as unknown as TableRow[]).map((table) => {
      const tableName = table.table_name;
      
      const tableColumns = (columns.rows as unknown as ColumnRow[])
        .filter((col) => col.table_name === tableName)
        .map((col) => ({
          name: col.column_name,
          type: col.data_type,
          nullable: col.is_nullable === 'YES',
          default: col.column_default,
          maxLength: col.character_maximum_length,
          precision: col.numeric_precision,
          scale: col.numeric_scale,
          position: col.ordinal_position,
          comment: col.column_comment
        }));

      const tableConstraints = (constraints.rows as unknown as ConstraintRow[])
        .filter((constraint) => constraint.table_name === tableName)
        .map((constraint) => ({
          name: constraint.constraint_name,
          type: constraint.constraint_type,
          column: constraint.column_name,
          foreignTable: constraint.foreign_table_name,
          foreignColumn: constraint.foreign_column_name
        }));

      const tableIndexes = (indexes.rows as unknown as IndexRow[])
        .filter((index) => index.tablename === tableName)
        .map((index) => ({
          name: index.indexname,
          definition: index.indexdef
        }));

      return {
        name: tableName,
        type: table.table_type,
        comment: table.table_comment,
        columns: tableColumns,
        constraints: tableConstraints,
        indexes: tableIndexes
      };
    });

    return Response.json({ tables: schemaData });
  } catch (error) {
    loggers.api.error('Error fetching schema:', error as Error);
    return Response.json(
      { error: 'Failed to fetch schema data' },
      { status: 500 }
    );
  }
}