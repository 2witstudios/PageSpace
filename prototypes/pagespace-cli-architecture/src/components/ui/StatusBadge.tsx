import type { CSSProperties } from "react";

const variants: Record<string, CSSProperties> = {
  live: {
    background: "rgba(61,214,140,0.1)",
    color: "var(--green)",
    border: "1px solid rgba(61,214,140,0.2)",
  },
  methodology: {
    background: "rgba(77,142,255,0.1)",
    color: "var(--blue)",
    border: "1px solid rgba(77,142,255,0.2)",
  },
  spec: {
    background: "rgba(255,184,77,0.1)",
    color: "var(--amber)",
    border: "1px solid rgba(255,184,77,0.2)",
  },
  planned: {
    background: "rgba(91,91,114,0.1)",
    color: "var(--dim)",
    border: "1px solid var(--border)",
  },
};

const base: CSSProperties = {
  display: "inline-block",
  fontSize: 9,
  fontWeight: 600,
  padding: "2px 8px",
  borderRadius: 20,
  marginLeft: 8,
  letterSpacing: 0.3,
  verticalAlign: "middle",
  fontFamily: "var(--mono)",
};

export function StatusBadge({ variant }: { variant: keyof typeof variants }) {
  return <span style={{ ...base, ...variants[variant] }}>{variant}</span>;
}
