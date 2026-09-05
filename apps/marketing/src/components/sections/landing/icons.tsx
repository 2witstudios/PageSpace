import type { ReactNode } from "react";

/**
 * Inline lucide-style icon paths at stroke-width 1.5 (matches the real app).
 * Used by the demo mocks where a compact, self-contained SVG is clearer than a
 * lucide-react import per glyph. Section-level chrome uses lucide-react directly.
 */
export const ICON_PATHS: Record<string, ReactNode> = {
  fileText: (<><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M8 13h8M8 17h8" /></>),
  file: (<><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>),
  bot: (<><path d="M12 6V2H8" /><path d="m8 18-4 4V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2Z" /><path d="M2 12h2M20 12h2M9 11v2M15 11v2" /></>),
  channel: (<><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z" /><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" /></>),
  task: (<><path d="m9 11 3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>),
  sheet: (<><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M8 13h2M14 13h2M8 17h2M14 17h2" /></>),
  canvas: (<><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><circle cx="10" cy="12" r="2" /><path d="m20 17-1.3-1.3a2.4 2.4 0 0 0-3.4 0L9 22" /></>),
  code: (<><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="m10 13-2 2 2 2M14 13l2 2-2 2" /></>),
  folder: (<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />),
  tree: (<><path d="M20 10h-9M20 6h-9M20 14h-6M20 18h-6" /><path d="M4 4v13a2 2 0 0 0 2 2h2" /></>),
  updown: (<path d="m7 15 5 5 5-5M7 9l5-5 5 5" />),
  download: (<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />),
  book: (<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />),
  rows: (<path d="M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13" />),
  kanban: (<path d="M4 5v16M9 5v10M14 5v7M19 5v13" />),
  lgrid: (<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>),
  undo2: (<><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H10" /></>),
  redo2: (<><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H14" /></>),
  dollar: (<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />),
  percent: (<path d="M19 5 5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />),
  fx: (<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 17c2 0 2-4 3-4s1 4 3 4" /><path d="M8 8h1M15 8h1" /></>),
  maximize: (<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />),
  chevR: (<path d="m9 18 6-6-6-6" />),
  chevD: (<path d="m6 9 6 6 6-6" />),
  chevL: (<path d="m15 18-6-6 6-6" />),
  check: (<path d="M20 6 9 17l-5-5" />),
  checkCircle: (<><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="m9 11 3 3L22 4" /></>),
  bold: (<path d="M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z" />),
  italic: (<path d="M19 4h-9M14 20H5M15 4 9 20" />),
  strike: (<path d="M16 4H9a3 3 0 0 0-1 5.8M6 20h9M4 12h16" />),
  h1: (<><path d="M4 12h8M4 18V6M12 18V6" /><path d="M17 12l3-2v8" /></>),
  pil: (<path d="M13 4v16M17 4v16M19 4H9.5a4.5 4.5 0 0 0 0 9H13" />),
  list: (<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />),
  quote: (<path d="M6 17h3l2-4V7H5v6h3zM14 17h3l2-4V7h-6v6h3z" />),
  send: (<path d="M5 12h14M12 5l7 7-7 7" />),
  up: (<path d="M12 19V5M5 12l7-7 7 7" />),
  search: (<><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>),
  plus: (<path d="M5 12h14M12 5v14" />),
  clock: (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  zap: (<path d="M4 14h7l-1 7 10-11h-7l1-7z" />),
  at: (<><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>),
  chart: (<><path d="M3 3v18h18" /><path d="M18 17V9M13 17V5M8 17v-4" /></>),
  terminal: (<path d="M4 17l6-6-6-6M12 19h8" />),
  sparkle: (<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />),
  users: (<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>),
  sliders: (<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />),
  lock: (<><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>),
  undo: (<><path d="M3 7v6h6" /><path d="M3 13a9 9 0 1 0 3-7.7L3 8" /></>),
  database: (<><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></>),
  shieldCheck: (<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>),
  arrowRight: (<path d="M5 12h14M12 5l7 7-7 7" />),
  arrowUpRight: (<path d="M7 17 17 7M7 7h10v10" />),
  webby: (<><circle cx="12" cy="8" r="6" /><path d="M8.5 13.5 7 22l5-3 5 3-1.5-8.5" /></>),
};

export function Ico({ name, size, style }: { name: keyof typeof ICON_PATHS | string; size?: string; style?: React.CSSProperties }) {
  return (
    <svg className={`i${size ? " " + size : ""}`} viewBox="0 0 24 24" aria-hidden="true" style={style}>
      {ICON_PATHS[name]}
    </svg>
  );
}

export function Avatar({ size, bg, children }: { size: number; bg: string; children: ReactNode }) {
  return (
    <span
      className="av"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: bg }}
    >
      {children}
    </span>
  );
}
