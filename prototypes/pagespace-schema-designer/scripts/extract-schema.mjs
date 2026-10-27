import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(__dirname, "../../../packages/db/src/schema");
const OUT = resolve(__dirname, "../src/data/schema.json");

const files = readdirSync(SCHEMA_DIR, { withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith(".ts") && d.name !== "index.ts")
  .map((d) => d.name);

const enumsByJsVar = new Map();
const tablesByJsVar = new Map();
const tables = [];

for (const file of files) {
  const src = readFileSync(join(SCHEMA_DIR, file), "utf8");
  const lines = src.split("\n");

  let state = "idle";
  let table = null;
  let depth = 0;
  let pendingColumn = null;

  const finalizeColumn = () => {
    if (pendingColumn && table) table.columns.push(pendingColumn);
    pendingColumn = null;
  };

  const Q = `['"]`;
  const enumRe = new RegExp(`export\\s+const\\s+(\\w+)\\s*=\\s*pgEnum\\(\\s*${Q}([^'"]+)${Q}\\s*,\\s*\\[([^\\]]*)\\]`);
  const tableStartRe = /export\s+const\s+(\w+)\s*=\s*pgTable\(/;
  const firstQuotedRe = new RegExp(`${Q}([^'"]+)${Q}`);
  const columnRe = new RegExp(`^\\s*(\\w+)\\s*:\\s*(\\w+)\\s*\\(\\s*${Q}([^'"]+)${Q}`);
  const referencesRe = /\.references\(\s*\(\)\s*=>\s*(\w+)\.(\w+)/;
  const onDeleteRe = new RegExp(`onDelete:\\s*${Q}([^'"]+)${Q}`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (state === "idle") {
      const em = enumRe.exec(line);
      if (em) {
        const [, jsVar, dbName, valuesRaw] = em;
        const values = [...valuesRaw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        enumsByJsVar.set(jsVar, { jsVar, dbName, values });
        continue;
      }
      const tm = tableStartRe.exec(line);
      if (tm) {
        let tableName = null;
        let scanI = i;
        const tailAfterCall = line.slice(line.indexOf("pgTable(") + "pgTable(".length);
        const inline = firstQuotedRe.exec(tailAfterCall);
        if (inline) {
          tableName = inline[1];
        } else {
          for (let k = i + 1; k <= Math.min(lines.length - 1, i + 3); k++) {
            const q = firstQuotedRe.exec(lines[k]);
            if (q) {
              tableName = q[1];
              scanI = k;
              break;
            }
          }
        }
        if (!tableName) continue;

        table = {
          jsVar: tm[1],
          tableName,
          file,
          columns: [],
          foreignKeys: [],
        };
        state = "table";
        depth = 0;
        pendingColumn = null;

        for (let k = i; k <= scanI; k++) {
          for (const ch of lines[k]) {
            if (ch === "{") depth++;
            else if (ch === "}") depth--;
          }
        }
        i = scanI;
      }
      continue;
    }

    if (state === "table") {
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }

      if (depth <= 0) {
        finalizeColumn();
        tablesByJsVar.set(table.jsVar, table);
        tables.push(table);
        table = null;
        state = "idle";
        continue;
      }

      if (depth === 1) {
        const cm = columnRe.exec(line);
        if (cm) {
          finalizeColumn();
          const [, propName, typeFn, dbCol] = cm;
          pendingColumn = {
            propName,
            dbName: dbCol,
            type: typeFn,
            isPrimaryKey: false,
            notNull: false,
            unique: false,
            fk: null,
          };
        }
      }

      if (pendingColumn) {
        if (/\.primaryKey\(\)/.test(line)) pendingColumn.isPrimaryKey = true;
        if (/\.notNull\(\)/.test(line)) pendingColumn.notNull = true;
        if (/\.unique\(/.test(line)) pendingColumn.unique = true;
        const rm = referencesRe.exec(line);
        if (rm) {
          const onDelete = onDeleteRe.exec(line) || onDeleteRe.exec(lines[i + 1] || "") || onDeleteRe.exec(lines[i + 2] || "");
          pendingColumn.fk = {
            targetJsVar: rm[1],
            targetProp: rm[2],
            onDelete: onDelete ? onDelete[1] : null,
          };
        }
      }

      if (depth === 1 && line.trim().endsWith(",") && pendingColumn) {
        const nextLine = lines[i + 1] || "";
        if (columnRe.test(nextLine) || /^\s*\}/.test(nextLine)) {
          finalizeColumn();
        }
      }
    }
  }
}

const tableByJsVar = Object.fromEntries(tables.map((t) => [t.jsVar, t]));

const foreignKeys = [];
for (const t of tables) {
  for (const c of t.columns) {
    if (c.fk) {
      const target = tableByJsVar[c.fk.targetJsVar];
      if (!target) continue;
      foreignKeys.push({
        id: `${t.tableName}.${c.dbName}->${target.tableName}.${c.fk.targetProp}`,
        sourceTable: t.tableName,
        sourceColumn: c.dbName,
        targetTable: target.tableName,
        targetColumnProp: c.fk.targetProp,
        onDelete: c.fk.onDelete,
      });
    }
  }
}

const cleanTables = tables.map((t) => ({
  name: t.tableName,
  jsVar: t.jsVar,
  file: t.file,
  columns: t.columns.map((c) => ({
    name: c.dbName,
    propName: c.propName,
    type: c.type,
    isPrimaryKey: c.isPrimaryKey,
    notNull: c.notNull,
    unique: c.unique,
    isForeignKey: !!c.fk,
  })),
}));

const enums = [...enumsByJsVar.values()];

const output = {
  generatedAt: new Date().toISOString(),
  schemaDir: "packages/db/src/schema",
  tables: cleanTables,
  foreignKeys,
  enums,
  stats: {
    tableCount: cleanTables.length,
    foreignKeyCount: foreignKeys.length,
    enumCount: enums.length,
  },
};

writeFileSync(OUT, JSON.stringify(output, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`  tables: ${cleanTables.length}`);
console.log(`  FKs: ${foreignKeys.length}`);
console.log(`  enums: ${enums.length}`);
