import type { CSSProperties, ReactNode } from "react";

const diagram: CSSProperties = {
  background: "var(--s1)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 28,
  marginBottom: 24,
};

const row: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "stretch",
  marginBottom: 8,
};

const label: CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: 1.5,
  textTransform: "uppercase" as const,
  color: "var(--dim)",
  writingMode: "vertical-rl" as const,
  transform: "rotate(180deg)",
  minWidth: 28,
  borderRight: "1px solid var(--border)",
  marginRight: 10,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 6,
};

const connector: CSSProperties = {
  display: "flex",
  alignItems: "center",
  fontSize: 10,
  color: "var(--dim)",
  gap: 6,
  padding: "3px 38px",
  fontFamily: "var(--mono)",
};

const lineStyle: CSSProperties = { flex: 1, height: 1, background: "var(--border)" };

export function ArchDiagram({ children }: { children: ReactNode }) {
  return <div style={diagram}>{children}</div>;
}

export function ArchRow({
  label: labelText,
  labelSub,
  children,
  style,
}: {
  label: string;
  labelSub?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ ...row, ...style }}>
      <div style={label}>
        {labelText}
        {labelSub && (
          <>
            <br />
            <span style={{ fontSize: 7, color: "var(--violet)" }}>
              {labelSub}
            </span>
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flex: 1, flexWrap: "wrap" }}>
        {children}
      </div>
    </div>
  );
}

export function ArchNode({
  title,
  titleColor,
  detail,
  borderColor,
  status,
  style,
}: {
  title: string;
  titleColor?: string;
  detail: string;
  borderColor?: string;
  status?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: "var(--s2)",
        border: `1px solid ${borderColor ?? "var(--border)"}`,
        borderRadius: 10,
        padding: "14px 16px",
        flex: 1,
        minWidth: 120,
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          marginBottom: 4,
          color: titleColor,
        }}
      >
        {title} {status}
      </div>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--dim)",
          lineHeight: 1.7,
        }}
        dangerouslySetInnerHTML={{ __html: detail }}
      />
    </div>
  );
}

export function ArchConnector({ text }: { text: string }) {
  return (
    <div style={connector}>
      <span style={lineStyle} />
      {text}
      <span style={lineStyle} />
    </div>
  );
}
