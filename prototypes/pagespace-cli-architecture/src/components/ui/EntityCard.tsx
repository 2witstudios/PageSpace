import type { CSSProperties, ReactNode } from "react";

const entity: CSSProperties = {
  background: "var(--s1)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  overflow: "hidden",
};

const header: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
  fontFamily: "var(--mono)",
  fontSize: 12,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  background: "var(--s2)",
};

const field: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  padding: "5px 14px",
  borderBottom: "1px solid rgba(42,42,61,0.5)",
  fontFamily: "var(--mono)",
  fontSize: 11,
  alignItems: "center",
};

export function EntityCard({
  name,
  badge,
  children,
}: {
  name: string;
  badge: string;
  children: ReactNode;
}) {
  return (
    <div style={entity}>
      <div style={header}>
        <span style={{ color: "var(--cyan)", fontWeight: 500 }}>{name}</span>
        <span style={{ fontSize: 9, color: "var(--dim)" }}>{badge}</span>
      </div>
      {children}
    </div>
  );
}

type FieldKind = "pk" | "rel" | "dim" | "default";
type TypeKind = "enum" | "default";

export function EntityField({
  name: fieldName,
  type,
  fieldKind = "default",
  typeKind = "default",
}: {
  name: string;
  type: string;
  fieldKind?: FieldKind;
  typeKind?: TypeKind;
}) {
  const nameColors: Record<FieldKind, string> = {
    pk: "var(--amber)",
    rel: "var(--blue)",
    dim: "var(--dim)",
    default: "var(--text)",
  };

  return (
    <div style={field}>
      <span style={{ color: nameColors[fieldKind] }}>{fieldName}</span>
      <span
        style={{
          color: typeKind === "enum" ? "var(--red)" : "var(--dim)",
          fontSize: 10,
        }}
      >
        {type}
      </span>
    </div>
  );
}
