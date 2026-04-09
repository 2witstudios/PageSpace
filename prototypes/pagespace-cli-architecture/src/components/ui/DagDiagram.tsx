import type { CSSProperties, ReactNode } from "react";

const container: CSSProperties = {
  background: "var(--s1)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 32,
  marginBottom: 24,
  overflowX: "auto",
};

const nodeColors: Record<string, CSSProperties> = {
  blue: {
    borderColor: "rgba(77,142,255,0.4)",
    background: "rgba(77,142,255,0.04)",
  },
  cyan: {
    borderColor: "rgba(34,211,238,0.4)",
    background: "rgba(34,211,238,0.04)",
  },
  red: {
    borderColor: "rgba(255,77,106,0.4)",
    background: "rgba(255,77,106,0.04)",
  },
  green: {
    borderColor: "rgba(61,214,140,0.4)",
    background: "rgba(61,214,140,0.04)",
  },
  amber: {
    borderColor: "rgba(255,184,77,0.4)",
    background: "rgba(255,184,77,0.04)",
  },
  violet: {
    borderColor: "rgba(167,139,250,0.4)",
    background: "rgba(167,139,250,0.04)",
  },
};

export function DagContainer({ children }: { children: ReactNode }) {
  return <div style={container}>{children}</div>;
}

export function DagRow({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 14,
        alignItems: "center",
        justifyContent: "center",
        marginBottom: 16,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function DagNode({
  type,
  name,
  color,
  style,
}: {
  type: string;
  name: string;
  color: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        border: "2px solid var(--border)",
        borderRadius: 10,
        padding: "14px 18px",
        minWidth: 130,
        textAlign: "center",
        background: "var(--s1)",
        ...nodeColors[color],
        ...style,
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 9,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: "var(--dim)",
          marginBottom: 4,
        }}
      >
        {type}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700 }}>{name}</div>
    </div>
  );
}

export function DagEdge() {
  return (
    <span
      style={{ fontSize: 18, color: "var(--border2)", flexShrink: 0 }}
    >
      &rarr;
    </span>
  );
}

export function DagVertical({
  label,
  color,
}: {
  label: string;
  color?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 9,
          color: color ?? "var(--dim)",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, color: "var(--border2)" }}>&darr;</div>
    </div>
  );
}
