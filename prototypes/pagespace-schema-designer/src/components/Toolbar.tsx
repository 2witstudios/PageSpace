import type { Domain } from "../lib/types";

interface ToolbarProps {
  search: string;
  onSearch: (s: string) => void;
  domains: Domain[];
  activeDomain: string | null;
  onDomainChange: (d: string | null) => void;
  onAutoLayout: () => void;
  onFitView: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  stats: { tables: number; fks: number };
}

export default function Toolbar({
  search,
  onSearch,
  domains,
  activeDomain,
  onDomainChange,
  onAutoLayout,
  onFitView,
  onCollapseAll,
  onExpandAll,
  stats,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar-brand">
        <span className="brand-mark" />
        <span className="brand-title">Schema Designer</span>
        <span className="brand-sub">
          {stats.tables} tables · {stats.fks} relations
        </span>
      </div>

      <div className="toolbar-cluster">
        <input
          type="search"
          placeholder="Search tables or columns…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="toolbar-input"
        />
        <select
          value={activeDomain ?? ""}
          onChange={(e) => onDomainChange(e.target.value || null)}
          className="toolbar-select"
        >
          <option value="">All domains</option>
          {domains.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar-cluster">
        <button className="tbtn" onClick={onAutoLayout}>Auto-layout</button>
        <button className="tbtn" onClick={onFitView}>Fit view</button>
        <button className="tbtn" onClick={onCollapseAll}>Collapse</button>
        <button className="tbtn" onClick={onExpandAll}>Expand</button>
      </div>
    </div>
  );
}
