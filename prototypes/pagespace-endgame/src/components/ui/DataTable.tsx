import type { CSSProperties, ReactNode } from "react";

const table: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const th: CSSProperties = {
  textAlign: "left",
  fontSize: 10,
  fontWeight: 600,
  color: "var(--dim)",
  letterSpacing: 1.2,
  textTransform: "uppercase" as const,
  padding: "8px 14px",
  borderBottom: "1px solid var(--border)",
};

export function DataTable({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
}) {
  return (
    <table style={table}>
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h} style={th}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

const td: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid rgba(42,42,61,0.5)",
  verticalAlign: "top",
};

export function CompareRow({
  capability,
  pagespace,
  col2,
  verdict,
  verdictColor,
}: {
  capability: string;
  pagespace: string;
  col2: string;
  verdict: string;
  verdictColor?: string;
}) {
  return (
    <tr>
      <td style={{ ...td, fontWeight: 600, color: "var(--text)", fontSize: 12 }}>
        {capability}
      </td>
      <td style={{ ...td, fontSize: 12, color: "var(--green)" }}>{pagespace}</td>
      <td style={{ ...td, fontSize: 12, color: "var(--violet)" }}>{col2}</td>
      <td
        style={{
          ...td,
          fontSize: 11,
          fontWeight: 600,
          color: verdictColor ?? "var(--mid)",
        }}
      >
        {verdict}
      </td>
    </tr>
  );
}

export function SectionHeader({ text, color }: { text: string; color: string }) {
  return (
    <tr style={{ background: `${color}08` }}>
      <td
        colSpan={4}
        style={{
          fontSize: 9,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color,
          fontWeight: 600,
          padding: "10px 14px 6px",
        }}
      >
        {text}
      </td>
    </tr>
  );
}
