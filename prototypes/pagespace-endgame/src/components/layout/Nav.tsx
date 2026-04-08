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
  | "story"
  | "runtime"
  | "memory"
  | "rag"
  | "governance"
  | "database"
  | "interfaces"
  | "roadmap"
  | "epics";

const tabs: { id: PaneId; label: string }[] = [
  { id: "story", label: "PageSpace OS" },
  { id: "runtime", label: "Runtime" },
  { id: "memory", label: "Memory" },
  { id: "rag", label: "RAG & Search" },
  { id: "governance", label: "Governance" },
  { id: "database", label: "Database & Infra" },
  { id: "interfaces", label: "Interfaces" },
  { id: "roadmap", label: "Roadmap" },
  { id: "epics", label: "Epics & Tasks" },
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
