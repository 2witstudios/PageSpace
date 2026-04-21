import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { TableNodeData } from "../lib/types";

const typeDisplay = (t: string): string => {
  if (t.endsWith("Enum")) return "enum";
  return t;
};

export default function TableNode({ id, data }: NodeProps) {
  const d = data as TableNodeData;
  const { table, domain, collapsed, dimmed, onToggleCollapse } = d;
  return (
    <div className={`table-node ${dimmed ? "is-dimmed" : ""}`} style={{ borderTopColor: domain.color }}>
      <header
        className="table-node-header"
        onClick={(e) => {
          e.stopPropagation();
          onToggleCollapse(id);
        }}
        title="Click to collapse / expand"
      >
        <span className="table-node-dot" style={{ background: domain.color }} />
        <span className="table-node-title">{table.name}</span>
        <span className="table-node-file">{domain.label}</span>
      </header>

      {!collapsed && (
        <ul className="table-node-columns">
          {table.columns.map((c) => (
            <li key={c.name} className={`col-row ${c.isPrimaryKey ? "is-pk" : ""} ${c.isForeignKey ? "is-fk" : ""}`}>
              <Handle
                type="target"
                position={Position.Left}
                id={`${c.name}-t`}
                className="col-handle col-handle-left"
              />
              <span className="col-markers">
                {c.isPrimaryKey && <span className="marker marker-pk" title="Primary key">PK</span>}
                {c.isForeignKey && <span className="marker marker-fk" title="Foreign key">FK</span>}
                {c.unique && !c.isPrimaryKey && <span className="marker marker-u" title="Unique">U</span>}
              </span>
              <span className="col-name">{c.name}</span>
              <span className="col-type">{typeDisplay(c.type)}{c.notNull ? "" : "?"}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={`${c.name}-s`}
                className="col-handle col-handle-right"
              />
            </li>
          ))}
        </ul>
      )}
      {collapsed && (
        <div className="table-node-collapsed-hint">
          {table.columns.length} columns
        </div>
      )}
    </div>
  );
}
