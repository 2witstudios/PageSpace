import { useState, type CSSProperties } from "react";

const nav: CSSProperties = {
  display: "flex",
  gap: 2,
  padding: "0 28px",
  borderBottom: "1px solid var(--border)",
  overflow: "visible",
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
  | "vision"
  | "story"
  | "runtime"
  | "memory"
  | "governance"
  | "security"
  | "observability"
  | "integrations"
  | "database"
  | "interfaces"
  | "agent-tools"

  | "gdpr"
  | "soc2"
  | "hipaa"
  | "stories"
  | "convergence";

const infraChildren: { id: PaneId; label: string }[] = [
  // Engine — what runs and what it can do
  { id: "runtime", label: "Runtime" },
  { id: "agent-tools", label: "Agent Tools" },
  { id: "memory", label: "Memory & Retrieval" },
  { id: "database", label: "Database" },
  // Connections — how it reaches out
  { id: "integrations", label: "Integrations" },
  // Controls — who governs, what's visible, is it safe
  { id: "governance", label: "Governance" },
  { id: "observability", label: "Observability" },
  { id: "security", label: "Security" },
  // Future — the lenses on the engine
  { id: "interfaces", label: "Interfaces" },
];

const complianceChildren: { id: PaneId; label: string }[] = [
  { id: "gdpr", label: "GDPR" },
  { id: "soc2", label: "SOC 2" },
  { id: "hipaa", label: "HIPAA" },
];

const infraIds = new Set(infraChildren.map((c) => c.id));
const complianceIds = new Set(complianceChildren.map((c) => c.id));

const topTabs: { id: PaneId | "infra" | "compliance-menu"; label: string }[] = [
  { id: "vision", label: "Vision" },
  { id: "story", label: "Roadmap" },
  { id: "infra", label: "Infrastructure" },
  { id: "compliance-menu", label: "Compliance" },
  { id: "stories", label: "User Stories" },
  { id: "convergence", label: "OpenFang + PageSpace" },
];

const dropdownStyle: CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  background: "var(--s1)",
  border: "1px solid var(--border)",
  borderRadius: "0 0 10px 10px",
  padding: "6px 0",
  minWidth: 200,
  zIndex: 300,
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
};

const dropItemBase: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  fontSize: 11,
  fontWeight: 500,
  padding: "8px 16px",
  background: "none",
  border: "none",
  color: "var(--dim)",
  cursor: "pointer",
  fontFamily: "var(--sans)",
  letterSpacing: 0.2,
  transition: "all 0.1s",
};

const dropItemActive: CSSProperties = {
  ...dropItemBase,
  color: "var(--blue)",
  background: "rgba(77,142,255,0.06)",
};

const dropItemHover: CSSProperties = {
  ...dropItemBase,
  color: "var(--text)",
  background: "var(--s2)",
};

function DropdownMenu({
  label,
  items,
  active,
  isActive,
  open,
  setOpen,
  onSelect,
}: {
  label: string;
  items: { id: PaneId; label: string }[];
  active: PaneId;
  isActive: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  onSelect: (id: PaneId) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { setOpen(false); setHovered(null); }}
    >
      <button
        style={{
          ...btnBase,
          ...(isActive ? { color: "var(--blue)", borderBottomColor: "var(--blue)" } : {}),
        }}
      >
        {label}
        <span style={{ fontSize: 8, marginLeft: 4, opacity: 0.5 }}>&#x25BC;</span>
      </button>
      {open && (
        <div style={dropdownStyle}>
          {items.map((child) => (
            <button
              key={child.id}
              style={
                active === child.id
                  ? dropItemActive
                  : hovered === child.id
                  ? dropItemHover
                  : dropItemBase
              }
              onMouseEnter={() => setHovered(child.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => {
                onSelect(child.id);
                setOpen(false);
              }}
            >
              {child.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Nav({
  active,
  onSelect,
}: {
  active: PaneId;
  onSelect: (id: PaneId) => void;
}) {
  const [infraOpen, setInfraOpen] = useState(false);
  const [complianceOpen, setComplianceOpen] = useState(false);

  return (
    <nav style={nav}>
      {topTabs.map((t) => {
        if (t.id === "infra") {
          return (
            <DropdownMenu
              key="infra"
              label="Infrastructure"
              items={infraChildren}
              active={active}
              isActive={infraIds.has(active)}
              open={infraOpen}
              setOpen={setInfraOpen}
              onSelect={onSelect}
            />
          );
        }

        if (t.id === "compliance-menu") {
          return (
            <DropdownMenu
              key="compliance"
              label="Compliance"
              items={complianceChildren}
              active={active}
              isActive={complianceIds.has(active)}
              open={complianceOpen}
              setOpen={setComplianceOpen}
              onSelect={onSelect}
            />
          );
        }

        const paneId = t.id as PaneId;
        return (
          <button
            key={t.id}
            style={paneId === active ? btnActive : btnBase}
            onClick={() => onSelect(paneId)}
          >
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
