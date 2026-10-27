import type { CSSProperties, ReactNode } from "react";

const accentStyles: Record<string, CSSProperties> = {
  blue: { borderLeft: "3px solid var(--blue)" },
  green: { borderLeft: "3px solid var(--green)" },
  red: { borderLeft: "3px solid var(--red)" },
  amber: { borderLeft: "3px solid var(--amber)" },
  violet: { borderLeft: "3px solid var(--violet)" },
  cyan: { borderLeft: "3px solid var(--cyan)" },
};

const base: CSSProperties = {
  background: "var(--s1)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "20px 22px",
};

export function Card({
  accent,
  children,
  style,
}: {
  accent?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        ...base,
        ...(accent ? accentStyles[accent] : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}
