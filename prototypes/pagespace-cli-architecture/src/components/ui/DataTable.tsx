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

const td: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid rgba(42,42,61,0.5)",
  verticalAlign: "top",
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

export function TraceRow({
  from,
  rel,
  to,
  desc,
}: {
  from: string;
  rel: string;
  to: string;
  desc: string;
}) {
  return (
    <tr>
      <td
        style={{
          ...td,
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--amber)",
        }}
      >
        {from}
      </td>
      <td
        style={{
          ...td,
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--violet)",
        }}
      >
        {rel}
      </td>
      <td
        style={{
          ...td,
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--cyan)",
        }}
      >
        {to}
      </td>
      <td
        style={{
          ...td,
          fontFamily: "var(--sans)",
          color: "var(--dim)",
          fontSize: 11,
        }}
      >
        {desc}
      </td>
    </tr>
  );
}

export function DecisionRow({
  area,
  decision,
  rationale,
  status,
  impl,
}: {
  area: string;
  decision: string;
  rationale: string;
  status: ReactNode;
  impl: ReactNode;
}) {
  return (
    <tr>
      <td
        style={{
          ...td,
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--mid)",
        }}
      >
        {area}
      </td>
      <td style={{ ...td, fontWeight: 600 }}>{decision}</td>
      <td style={{ ...td, fontSize: 12, color: "var(--dim)" }}>
        {rationale}
      </td>
      <td style={td}>{status}</td>
      <td style={td}>{impl}</td>
    </tr>
  );
}

export function SectionHeader({
  text,
  color,
}: {
  text: string;
  color: string;
}) {
  return (
    <tr style={{ background: `${color}03` }}>
      <td
        colSpan={5}
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
