"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, Search, Key, Link } from "lucide-react";

interface Column {
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

interface Constraint {
  name: string;
  type: string;
  column: string;
  foreignTable: string | null;
  foreignColumn: string | null;
}

interface Index {
  name: string;
  definition: string;
}

interface TableData {
  name: string;
  type: string;
  comment: string | null;
  columns: Column[];
  constraints: Constraint[];
  indexes: Index[];
}

interface SchemaTableProps {
  tables: TableData[];
}

function getTypeColor(type: string): string {
  const typeMap: Record<string, string> = {
    'text': 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
    'timestamp': 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
    'boolean': 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
    'integer': 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
    'real': 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
    'jsonb': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
    'USER-DEFINED': 'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300',
  };
  
  return typeMap[type] || 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300';
}

function getConstraintIcon(type: string) {
  switch (type) {
    case 'PRIMARY KEY':
      return <Key className="h-3 w-3" />;
    case 'FOREIGN KEY':
      return <Link className="h-3 w-3" />;
    default:
      return null;
  }
}

export function SchemaTable({ tables }: SchemaTableProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});

  const filteredTables = tables.filter(table =>
    table.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    table.columns.some(col => 
      col.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      col.type.toLowerCase().includes(searchTerm.toLowerCase())
    )
  );

  const toggleTable = (tableName: string) => {
    setExpandedTables(prev => ({
      ...prev,
      [tableName]: !prev[tableName]
    }));
  };

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search tables, columns, or types..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      <div className="grid gap-4">
        {filteredTables.map((table) => (
          <Card key={table.name}>
            <Collapsible 
              open={expandedTables[table.name]} 
              onOpenChange={() => toggleTable(table.name)}
            >
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      {expandedTables[table.name] ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      <CardTitle className="text-lg">{table.name}</CardTitle>
                      <Badge variant="outline">
                        {table.columns.length} columns
                      </Badge>
                    </div>
                    <div className="flex space-x-2">
                      {table.constraints.filter(c => c.type === 'PRIMARY KEY').length > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          <Key className="h-3 w-3 mr-1" />
                          PK
                        </Badge>
                      )}
                      {table.constraints.filter(c => c.type === 'FOREIGN KEY').length > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          <Link className="h-3 w-3 mr-1" />
                          FK
                        </Badge>
                      )}
                    </div>
                  </div>
                  {table.comment && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {table.comment}
                    </p>
                  )}
                </CardHeader>
              </CollapsibleTrigger>

              <CollapsibleContent>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Column</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Nullable</TableHead>
                        <TableHead>Default</TableHead>
                        <TableHead>Constraints</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {table.columns.map((column) => {
                        const columnConstraints = table.constraints.filter(
                          c => c.column === column.name
                        );
                        
                        return (
                          <TableRow key={column.name}>
                            <TableCell className="font-medium">
                              {column.name}
                            </TableCell>
                            <TableCell>
                              <Badge 
                                variant="secondary" 
                                className={getTypeColor(column.type)}
                              >
                                {column.type}
                                {column.maxLength && `(${column.maxLength})`}
                                {column.precision && column.scale && `(${column.precision},${column.scale})`}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <Badge variant={column.nullable ? "outline" : "destructive"}>
                                {column.nullable ? "NULL" : "NOT NULL"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {column.default || "-"}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {columnConstraints.map((constraint) => (
                                  <Badge 
                                    key={constraint.name} 
                                    variant="outline" 
                                    className="text-xs"
                                  >
                                    {getConstraintIcon(constraint.type)}
                                    <span className="ml-1">
                                      {constraint.type === 'PRIMARY KEY' ? 'PK' :
                                       constraint.type === 'FOREIGN KEY' ? `FK → ${constraint.foreignTable}` :
                                       constraint.type}
                                    </span>
                                  </Badge>
                                ))}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>

                  {table.indexes.length > 0 && (
                    <div className="mt-4">
                      <h4 className="text-sm font-medium mb-2">Indexes</h4>
                      <div className="text-xs text-muted-foreground space-y-1">
                        {table.indexes.map((index) => (
                          <div key={index.name} className="font-mono">
                            <span className="font-medium">{index.name}:</span> {index.definition}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>
        ))}
      </div>
    </div>
  );
}