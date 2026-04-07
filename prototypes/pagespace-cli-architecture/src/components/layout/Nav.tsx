import type { CSSProperties } from "react";

const nav: CSSProperties = {
  display: "flex",
  gap: 2,
  padding: "0 28px",
  borderBottom: "1px solid var(--border)",
  overflowX: "auto",
  position: "sticky",
  top: 53,
  background: "rgba(9,9,15,0.92)",
  backdropFilter: "blur(16px)",
  zIndex: 199,
};

const btnBase: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  padding: "10px 14px 12px",
  background: "none",
  border: "none",
  color: "var(--dim)",
  cursor: "pointer",
  borderBottom: "2px solid transparent",
  transition: "all 0.15s",
  whiteSpace: "nowrap",
  letterSpacing: 0.2,
  fontFamily: "var(--sans)",
};

const btnActive: CSSProperties = {
  ...btnBase,
  color: "var(--blue)",
  borderBottomColor: "var(--blue)",
};

export type PaneId =
  | "product"
  | "architecture"
  | "workspace"
  | "containers"
  | "entities"
  | "contexts"
  | "parallel"
  | "rubric"
  | "workflow"
  | "rules"
  | "search"
  | "decisions"
  | "projects";

const tabs: { id: PaneId; label: string }[] = [
  { id: "product", label: "Product" },
  { id: "architecture", label: "Architecture" },
  { id: "workspace", label: "Interface" },
  { id: "containers", label: "Containers" },
  { id: "entities", label: "Data Model" },
  { id: "contexts", label: "Agent Isolation" },
  { id: "parallel", label: "Parallel Analysis" },
  { id: "rubric", label: "Scoring" },
  { id: "workflow", label: "Workflow DAG" },
  { id: "rules", label: "Events" },
  { id: "search", label: "Search" },
  { id: "decisions", label: "Decisions" },
  { id: "projects", label: "Projects & Epics" },
];

export function Nav({
  active,
  onSelect,
}: {
  active: PaneId;
  onSelect: (id: PaneId) => void;
}) {
  return (
    <nav style={nav}>
      {tabs.map((t) => (
        <button
          key={t.id}
          style={t.id === active ? btnActive : btnBase}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
