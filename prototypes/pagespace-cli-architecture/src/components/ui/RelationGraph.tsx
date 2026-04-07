import type { CSSProperties, ReactNode } from "react";

const graph: CSSProperties = {
  background: "var(--s1)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 28,
  marginBottom: 24,
  overflowX: "auto",
};

const entityColors: Record<string, CSSProperties> = {
  plan: {
    color: "var(--amber)",
    borderColor: "rgba(255,184,77,0.3)",
    background: "rgba(255,184,77,0.06)",
  },
  task: {
    color: "var(--violet)",
    borderColor: "rgba(167,139,250,0.3)",
    background: "rgba(167,139,250,0.06)",
  },
  ctx: {
    color: "var(--blue)",
    borderColor: "rgba(77,142,255,0.3)",
    background: "rgba(77,142,255,0.06)",
  },
  mut: {
    color: "var(--green)",
    borderColor: "rgba(61,214,140,0.3)",
    background: "rgba(61,214,140,0.06)",
  },
  rate: {
    color: "var(--red)",
    borderColor: "rgba(255,77,106,0.3)",
    background: "rgba(255,77,106,0.06)",
  },
  commit: {
    color: "var(--text)",
    borderColor: "var(--border2)",
    background: "rgba(226,226,239,0.04)",
  },
  pr: {
    color: "var(--cyan)",
    borderColor: "rgba(34,211,238,0.3)",
    background: "rgba(34,211,238,0.06)",
  },
  snap: {
    color: "var(--dim)",
    borderColor: "var(--border)",
    background: "rgba(91,91,114,0.06)",
  },
  project: {
    color: "var(--amber)",
    borderColor: "rgba(255,184,77,0.3)",
    background: "rgba(255,184,77,0.06)",
  },
  epic: {
    color: "var(--violet)",
    borderColor: "rgba(167,139,250,0.3)",
    background: "rgba(167,139,250,0.06)",
  },
  series: {
    color: "var(--cyan)",
    borderColor: "rgba(34,211,238,0.3)",
    background: "rgba(34,211,238,0.06)",
  },
};

export function RelationGraph({ children }: { children: ReactNode }) {
  return <div style={graph}>{children}</div>;
}

export function RelSection({
  title,
  children,
  style,
}: {
  title: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ marginBottom: 20, ...style }}>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: "var(--dim)",
          marginBottom: 10,
          paddingBottom: 6,
          borderBottom: "1px solid var(--border)",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

export function RelRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        marginBottom: 8,
        flexWrap: "wrap",
      }}
    >
      {children}
    </div>
  );
}

export function RelEntity({
  type,
  children,
}: {
  type: keyof typeof entityColors;
  children: ReactNode;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "5px 12px",
        borderRadius: 6,
        fontFamily: "var(--mono)",
        fontSize: 11,
        fontWeight: 500,
        border: "1px solid",
        whiteSpace: "nowrap",
        ...entityColors[type],
      }}
    >
      {children}
    </span>
  );
}

export function RelArrow() {
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: 11,
        color: "var(--dim)",
        padding: "0 4px",
      }}
    >
      &rarr;
    </span>
  );
}

export function RelLabel({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: 9,
        color: "var(--dim)",
        background: "var(--s3)",
        padding: "2px 6px",
        borderRadius: 4,
      }}
    >
      {children}
    </span>
  );
}

export function RelNote({
  color,
  children,
}: {
  color?: string;
  children: ReactNode;
}) {
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: 9,
        color: color ?? "var(--dim)",
        marginLeft: 8,
      }}
    >
      {children}
    </span>
  );
}
