import type { CSSProperties } from "react";

const fillColors: Record<string, string> = {
  high: "var(--green)",
  mid: "var(--amber)",
  low: "var(--red)",
};

export function ScoreBar({
  label,
  percent,
  level,
  value,
  labelWidth,
}: {
  label: string;
  percent: number;
  level: "high" | "mid" | "low";
  value: string;
  labelWidth?: number;
}) {
  const row: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  };
  const labelStyle: CSSProperties = {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--mid)",
    minWidth: labelWidth ?? 120,
  };
  const track: CSSProperties = {
    flex: 1,
    height: 6,
    background: "var(--s3)",
    borderRadius: 3,
    border: "1px solid var(--border)",
    overflow: "hidden",
  };
  const fill: CSSProperties = {
    height: "100%",
    borderRadius: 3,
    width: `${percent}%`,
    background: fillColors[level],
  };
  const val: CSSProperties = {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: level === "low" ? "var(--red)" : "var(--dim)",
    minWidth: 30,
    textAlign: "right",
  };

  return (
    <div style={row}>
      <span style={labelStyle}>{label}</span>
      <div style={track}>
        <div style={fill} />
      </div>
      <span style={val}>{value}</span>
    </div>
  );
}
