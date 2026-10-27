import type { CSSProperties } from "react";

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px 28px",
  borderBottom: "1px solid var(--border)",
  position: "sticky",
  top: 0,
  background: "rgba(9,9,15,0.92)",
  backdropFilter: "blur(16px)",
  zIndex: 200,
};

const wordmark: CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: -0.3,
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const pillBase: CSSProperties = {
  fontSize: 10,
  padding: "3px 10px",
  borderRadius: 20,
  border: "1px solid var(--border)",
  color: "var(--dim)",
  fontWeight: 500,
};

const pillLit: CSSProperties = {
  ...pillBase,
  color: "var(--blue)",
  borderColor: "rgba(77,142,255,0.3)",
  background: "rgba(77,142,255,0.06)",
};

const pills = [
  { label: "PageSpace primitives", lit: true },
  { label: "PurePoint orchestration", lit: true },
  { label: "AIDD methodology", lit: true },
  { label: "Real agent loops", lit: false },
];

export function Header() {
  return (
    <header style={header}>
      <div style={wordmark}>
        Pagespace{" "}
        <span style={{ color: "var(--blue)" }}>CLI</span>{" "}
        <span style={{ color: "var(--dim)", fontWeight: 300 }}>/</span>{" "}
        <span
          style={{
            fontSize: 11,
            color: "var(--dim)",
            fontWeight: 400,
            letterSpacing: 0.5,
          }}
        >
          Architecture
        </span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {pills.map((p) => (
          <span key={p.label} style={p.lit ? pillLit : pillBase}>
            {p.label}
          </span>
        ))}
      </div>
    </header>
  );
}
