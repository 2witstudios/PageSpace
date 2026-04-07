import type { CSSProperties, ReactNode } from "react";

const container: CSSProperties = {
  display: "grid",
  gap: 0,
  marginBottom: 28,
  border: "1px solid var(--border)",
  borderRadius: 14,
  overflow: "hidden",
  background: "var(--s1)",
};

const featureStyle: CSSProperties = {
  padding: "26px 24px",
  borderRight: "1px solid var(--border)",
};

export function FeatureRow({
  columns = 3,
  children,
  style,
}: {
  columns?: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        ...container,
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Feature({
  icon,
  name,
  nameColor,
  description,
  status,
  style,
}: {
  icon?: string;
  name: string;
  nameColor?: string;
  description: string;
  status?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ ...featureStyle, ...style }}>
      {icon && (
        <div
          style={{
            fontSize: 20,
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 40,
            height: 40,
            borderRadius: 10,
            background: "var(--s2)",
            border: "1px solid var(--border)",
            color: nameColor,
          }}
        >
          {icon}
        </div>
      )}
      <div
        style={{
          fontSize: style?.fontSize ?? 16,
          fontWeight: 700,
          marginBottom: 6,
          letterSpacing: -0.2,
          color: nameColor,
        }}
      >
        {name} {status}
      </div>
      <div
        style={{
          fontSize: style?.fontSize ? Number(style.fontSize) - 1.5 : 12.5,
          lineHeight: 1.7,
          color: "var(--mid)",
        }}
        dangerouslySetInnerHTML={{ __html: description }}
      />
    </div>
  );
}
