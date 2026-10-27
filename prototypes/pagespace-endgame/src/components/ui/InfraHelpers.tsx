import type { CSSProperties, ReactNode } from "react";

export function Svc({ name, detail, color, port, mem }: {
  name: string; detail: string; color?: string; port?: string; mem?: string;
}) {
  return (
    <div style={{
      background: "var(--s2)", border: `1px solid ${color ? `${color}40` : "var(--border)"}`,
      borderRadius: 8, padding: "8px 12px", flex: 1, minWidth: 80,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: color ?? "var(--text)" }}>{name}</div>
        {port && <span style={{ fontSize: 8, color: "var(--dim)", fontFamily: "var(--mono)" }}>{port}</span>}
      </div>
      <div style={{ fontSize: 8, color: "var(--dim)", fontFamily: "var(--mono)", lineHeight: 1.5 }}>{detail}</div>
      {mem && <div style={{ fontSize: 7, color: "var(--dim)", fontFamily: "var(--mono)", marginTop: 2 }}>mem: {mem}</div>}
    </div>
  );
}

export function Zone({ label, color, children, style, badge }: {
  label: string; color: string; children: ReactNode;
  style?: CSSProperties; badge?: string;
}) {
  return (
    <div style={{
      border: `1px solid ${color}30`, borderRadius: 12,
      background: `${color}06`, padding: "32px 14px 14px",
      position: "relative", ...style,
    }}>
      <div style={{
        position: "absolute", top: 8, left: 12,
        fontSize: 9, fontWeight: 600, letterSpacing: 1.2,
        textTransform: "uppercase" as CSSProperties["textTransform"],
        color, display: "flex", gap: 6, alignItems: "center",
      }}>
        {label}
        {badge && (
          <span style={{
            fontSize: 7, padding: "1px 5px", borderRadius: 10,
            background: `${color}15`, border: `1px solid ${color}30`,
            letterSpacing: 0, textTransform: "none" as CSSProperties["textTransform"],
            fontWeight: 500,
          }}>{badge}</span>
        )}
      </div>
      {children}
    </div>
  );
}

export function Flow({ label, color }: { label: string; color?: string }) {
  return (
    <div style={{
      textAlign: "center", padding: "3px 0", fontSize: 8,
      color: color ?? "var(--dim)", fontFamily: "var(--mono)",
      display: "flex", alignItems: "center", gap: 6, justifyContent: "center",
    }}>
      <span style={{ flex: 1, maxWidth: 40, height: 1, background: color ?? "var(--border)" }} />
      <span>&#x25BC; {label}</span>
      <span style={{ flex: 1, maxWidth: 40, height: 1, background: color ?? "var(--border)" }} />
    </div>
  );
}

export function Callout({ title, color, children }: {
  title: string; color: string; children: ReactNode;
}) {
  return (
    <div style={{
      borderLeft: `3px solid ${color}`,
      background: "var(--s1)", borderRadius: "0 10px 10px 0",
      padding: "14px 16px", marginBottom: 12,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 11, color: "var(--mid)", lineHeight: 1.7 }}>{children}</div>
    </div>
  );
}

export function CronJob({ schedule, name, endpoint }: { schedule: string; name: string; endpoint: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 9, fontFamily: "var(--mono)", color: "var(--dim)", lineHeight: 1.8 }}>
      <span style={{ color: "var(--amber)", minWidth: 65 }}>{schedule}</span>
      <span style={{ color: "var(--text)", minWidth: 100 }}>{name}</span>
      <span>{endpoint}</span>
    </div>
  );
}

export function MigrationArrow({ label }: { label: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "24px 0", gap: 12,
    }}>
      <span style={{ flex: 1, maxWidth: 200, height: 1, background: "var(--blue)" }} />
      <span style={{
        fontSize: 11, fontWeight: 700, color: "var(--blue)",
        padding: "6px 20px", borderRadius: 20,
        border: "1px solid rgba(77,142,255,0.3)",
        background: "rgba(77,142,255,0.06)",
        letterSpacing: 0.5,
      }}>
        &#x25BC; {label}
      </span>
      <span style={{ flex: 1, maxWidth: 200, height: 1, background: "var(--blue)" }} />
    </div>
  );
}
