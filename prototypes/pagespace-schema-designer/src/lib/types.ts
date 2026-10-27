export interface ColumnSchema {
  name: string;
  propName: string;
  type: string;
  isPrimaryKey: boolean;
  notNull: boolean;
  unique: boolean;
  isForeignKey: boolean;
}

export interface TableSchema {
  name: string;
  jsVar: string;
  file: string;
  columns: ColumnSchema[];
}

export interface ForeignKeySchema {
  id: string;
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumnProp: string;
  onDelete: string | null;
}

export interface EnumSchema {
  jsVar: string;
  dbName: string;
  values: string[];
}

export interface SchemaDoc {
  generatedAt: string;
  schemaDir: string;
  tables: TableSchema[];
  foreignKeys: ForeignKeySchema[];
  enums: EnumSchema[];
  stats: {
    tableCount: number;
    foreignKeyCount: number;
    enumCount: number;
  };
}

export interface TableNodeData {
  table: TableSchema;
  domain: Domain;
  collapsed: boolean;
  dimmed: boolean;
  onToggleCollapse: (id: string) => void;
  [key: string]: unknown;
}

export interface Domain {
  key: string;
  label: string;
  color: string;
}
