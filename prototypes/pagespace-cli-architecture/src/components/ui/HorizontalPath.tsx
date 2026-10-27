import type { CSSProperties, ReactNode } from "react";

const pathStyle: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  overflowX: "auto",
  paddingBottom: 4,
  marginBottom: 28,
  gap: 0,
};

const stepColors: Record<string, CSSProperties> = {
  blue: {
    background: "rgba(77,142,255,0.04)",
    borderColor: "rgba(77,142,255,0.2)",
  },
  violet: {
    background: "rgba(167,139,250,0.04)",
    borderColor: "rgba(167,139,250,0.2)",
  },
  cyan: {
    background: "rgba(34,211,238,0.04)",
    borderColor: "rgba(34,211,238,0.2)",
  },
  red: {
    background: "rgba(255,77,106,0.04)",
    borderColor: "rgba(255,77,106,0.2)",
  },
  green: {
    background: "rgba(61,214,140,0.04)",
    borderColor: "rgba(61,214,140,0.2)",
  },
  amber: {
    background: "rgba(255,184,77,0.04)",
    borderColor: "rgba(255,184,77,0.2)",
  },
};

export function HorizontalPath({ children }: { children: ReactNode }) {
  return <div style={pathStyle}>{children}</div>;
}

export function PathStep({
  number,
  label,
  note,
  color,
  isFirst,
  isLast,
}: {
  number: string;
  label: string;
  note: string;
  color: string;
  isFirst?: boolean;
  isLast?: boolean;
}) {
  const colorStyles = stepColors[color] ?? {};
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        padding: 16,
        minWidth: 132,
        flexShrink: 0,
        position: "relative",
        borderRadius: isFirst
          ? "12px 0 0 12px"
          : isLast
            ? "0 12px 12px 0"
            : 0,
        borderLeft: isFirst ? undefined : "none",
        ...colorStyles,
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--dim)",
          marginBottom: 6,
        }}
      >
        {number}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
        {label}
      </div>
      <div
        style={{ fontSize: 10, color: "var(--dim)", lineHeight: 1.55 }}
        dangerouslySetInnerHTML={{ __html: note }}
      />
      {!isLast && (
        <span
          style={{
            position: "absolute",
            right: -10,
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--dim)",
            fontSize: 14,
            zIndex: 2,
            background: "var(--bg)",
            padding: "2px 0",
          }}
        >
          &rarr;
        </span>
      )}
    </div>
  );
}
