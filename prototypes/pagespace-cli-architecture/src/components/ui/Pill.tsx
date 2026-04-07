import type { CSSProperties, ReactNode } from "react";

const variants: Record<string, CSSProperties> = {
  blue: {
    background: "rgba(77,142,255,0.1)",
    color: "var(--blue)",
    border: "1px solid rgba(77,142,255,0.2)",
  },
  green: {
    background: "rgba(61,214,140,0.1)",
    color: "var(--green)",
    border: "1px solid rgba(61,214,140,0.2)",
  },
  red: {
    background: "rgba(255,77,106,0.1)",
    color: "var(--red)",
    border: "1px solid rgba(255,77,106,0.2)",
  },
  amber: {
    background: "rgba(255,184,77,0.1)",
    color: "var(--amber)",
    border: "1px solid rgba(255,184,77,0.2)",
  },
  violet: {
    background: "rgba(167,139,250,0.1)",
    color: "var(--violet)",
    border: "1px solid rgba(167,139,250,0.2)",
  },
  dim: {
    background: "rgba(91,91,114,0.1)",
    color: "var(--dim)",
    border: "1px solid var(--border)",
  },
};

const base: CSSProperties = {
  display: "inline-block",
  fontSize: 10,
  fontWeight: 500,
  padding: "2px 9px",
  borderRadius: 20,
  margin: 2,
  fontFamily: "var(--mono)",
};

export function Pill({
  variant = "dim",
  children,
}: {
  variant?: keyof typeof variants;
  children: ReactNode;
}) {
  return <span style={{ ...base, ...variants[variant] }}>{children}</span>;
}
