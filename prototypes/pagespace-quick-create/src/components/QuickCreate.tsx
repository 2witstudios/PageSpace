import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  FileText, FileCode, FileSpreadsheet, FileImage, File,
  Folder, BotMessageSquare, MessagesSquare, SquareCheckBig,
  ArrowLeft, Search, type LucideIcon,
} from "lucide-react";

// ─── Mock data ────────────────────────────────────────────────────────────────

interface PageType {
  id: string;
  icon: LucideIcon;
  iconColor: string;
  name: string;
  description: string;
  keywords: string[];
}

const PAGE_TYPES: PageType[] = [
  { id: "document",  icon: FileText,        iconColor: "#60a5fa", name: "Document",  description: "Rich text, headings, embeds",            keywords: ["doc", "note", "text", "rich"] },
  { id: "aichat",    icon: BotMessageSquare,iconColor: "#e879f9", name: "AI Chat",   description: "Conversation with an AI model",         keywords: ["gpt", "llm", "claude", "assistant", "openai"] },
  { id: "tasklist",  icon: SquareCheckBig,  iconColor: "#fb923c", name: "Task List", description: "Todos, assignments, and deadlines",      keywords: ["todo", "task", "checklist", "project"] },
  { id: "channel",   icon: MessagesSquare,  iconColor: "#38bdf8", name: "Channel",   description: "Threaded chat and discussion",           keywords: ["chat", "message", "discuss", "slack"] },
  { id: "folder",    icon: Folder,          iconColor: "#fbbf24", name: "Folder",    description: "Organise pages into a section",         keywords: ["dir", "group", "section", "org"] },
  { id: "sheet",     icon: FileSpreadsheet, iconColor: "#34d399", name: "Sheet",     description: "Spreadsheet with formulas",              keywords: ["table", "grid", "data", "excel", "csv"] },
  { id: "canvas",    icon: FileImage,       iconColor: "#f472b6", name: "Canvas",    description: "Freeform whiteboard and diagrams",       keywords: ["draw", "board", "diagram", "sketch", "figma"] },
  { id: "code",      icon: FileCode,        iconColor: "#a78bfa", name: "Code",      description: "Monaco editor with syntax highlighting", keywords: ["dev", "script", "editor"] },
  { id: "file",      icon: File,            iconColor: "#94a3b8", name: "File",      description: "Upload and store any file",             keywords: ["upload", "attachment", "pdf", "image"] },
];

interface BreadcrumbItem { id: string; name: string }

const MOCK_CONTEXTS: { label: string; crumbs: BreadcrumbItem[] }[] = [
  { label: "Drive root",               crumbs: [] },
  { label: "Projects",                 crumbs: [{ id: "1", name: "Projects" }] },
  { label: "Projects › Backend",       crumbs: [{ id: "1", name: "Projects" }, { id: "2", name: "Backend" }] },
  { label: "Projects › Backend › API", crumbs: [{ id: "1", name: "Projects" }, { id: "2", name: "Backend" }, { id: "3", name: "API Design" }] },
];

// ─── Shared primitives ────────────────────────────────────────────────────────

function KbdHint({ keys }: { keys: string[] }) {
  return (
    <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
      {keys.map((k) => (
        <kbd key={k} style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          height: 18, minWidth: 18, padding: "0 4px",
          background: "var(--muted)", border: "1px solid var(--border)",
          borderRadius: "calc(var(--radius) - 4px)",
          fontSize: 11, color: "var(--muted-foreground)",
          fontFamily: "inherit", fontWeight: 500, lineHeight: 1,
        }}>{k}</kbd>
      ))}
    </span>
  );
}

function ContextCrumbs({ crumbs }: { crumbs: BreadcrumbItem[] }) {
  if (crumbs.length === 0) return <span>Drive root</span>;
  return (
    <>
      {crumbs.map((c, i) => (
        <span key={c.id}>
          {i > 0 && <span style={{ margin: "0 3px", opacity: 0.4 }}>›</span>}
          <span style={{ color: i === crumbs.length - 1 ? "var(--foreground)" : "var(--muted-foreground)", fontWeight: i === crumbs.length - 1 ? 500 : 400 }}>{c.name}</span>
        </span>
      ))}
    </>
  );
}

// Matches app's CommandItem: rounded-sm px-2 py-1.5 text-sm + palette override py-2.5
// hover → bg-accent text-accent-foreground
function Item({
  active,
  onClick,
  onMouseEnter,
  children,
  style,
}: {
  active: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 8px",       // py-2.5 px-2 — matches palette's CommandItem override
        borderRadius: "calc(var(--radius) - 4px)",
        cursor: "default",
        background: active ? "var(--accent)" : "transparent",
        color: active ? "var(--accent-foreground)" : "var(--foreground)",
        transition: "background 80ms, color 80ms",
        fontSize: 14,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ─── Phase 1: Type selection ──────────────────────────────────────────────────

function TypeSelect({ crumbs, onSelect, onClose }: { crumbs: BreadcrumbItem[]; onSelect: (t: PageType) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return PAGE_TYPES;
    const q = query.toLowerCase();
    return PAGE_TYPES.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.keywords.some(k => k.includes(q))
    );
  }, [query]);

  useEffect(() => { setActiveIndex(0); }, [query]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const items = listRef.current?.querySelectorAll("[role=option]");
    (items?.[activeIndex] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[activeIndex]) onSelect(filtered[activeIndex]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }, [filtered, activeIndex, onSelect, onClose]);

  return (
    <>
      {/* Context line — matches "px-3 py-2 border-b" + "text-xs text-muted-foreground" */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
        <p style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
          In: <span style={{ fontWeight: 500, color: "var(--foreground)" }}><ContextCrumbs crumbs={crumbs} /></span>
        </p>
      </div>

      {/* CommandInput — "h-9 items-center gap-2 border-b px-3", input "h-12 text-sm" */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 12px", borderBottom: "1px solid var(--border)" }}>
        <Search size={16} style={{ color: "var(--muted-foreground)", flexShrink: 0, opacity: 0.5 }} />
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search page types…"
          style={{
            flex: 1, background: "none", border: "none", outline: "none",
            fontSize: 14, color: "var(--foreground)",
            padding: "14px 0",  // h-12 equivalent
          }}
        />
        <KbdHint keys={["⌥", "N"]} />
      </div>

      {/* CommandList — max-h-[300px], CommandGroup — p-1 */}
      <div ref={listRef} role="listbox" style={{ overflowY: "auto", maxHeight: 300, padding: 4 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: "24px 8px", textAlign: "center", fontSize: 14, color: "var(--muted-foreground)" }}>
            No matching types.
          </div>
        ) : filtered.map((type, i) => (
          <Item key={type.id} active={i === activeIndex} onClick={() => onSelect(type)} onMouseEnter={() => setActiveIndex(i)}>
            {/* Icon badge — w-6 equivalent (24px) */}
            <span style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, borderRadius: 6, flexShrink: 0,
              background: `color-mix(in oklch, ${type.iconColor} 15%, transparent)`,
            }}>
              <type.icon size={14} color={type.iconColor} strokeWidth={1.5} />
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{type.name}</span>
              <span style={{ fontSize: 12, color: i === activeIndex ? "var(--accent-foreground)" : "var(--muted-foreground)", opacity: i === activeIndex ? 0.8 : 1 }}>
                {type.description}
              </span>
            </span>
          </Item>
        ))}
      </div>
    </>
  );
}

// ─── Phase 2: Name entry ──────────────────────────────────────────────────────

function NameEntry({ type, crumbs, onBack, onCreate, onClose }: {
  type: PageType; crumbs: BreadcrumbItem[];
  onBack: () => void; onCreate: (name: string) => void; onClose: () => void;
}) {
  const [name, setName] = useState(`Untitled ${type.name}`);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 40);
    return () => clearTimeout(t);
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); onCreate(name.trim() || `Untitled ${type.name}`); }
    else if (e.key === "Escape") { e.preventDefault(); onBack(); }
  };

  return (
    <>
      {/* Header — "flex items-center gap-2 px-3 py-2.5 border-b" */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <button
          onClick={onBack}
          aria-label="Back"
          style={{ color: "var(--muted-foreground)", display: "flex", padding: 2, borderRadius: 4, transition: "color 120ms" }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = "var(--foreground)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = "var(--muted-foreground)"; }}
        >
          {/* ArrowLeft h-3.5 w-3.5 */}
          <ArrowLeft size={14} strokeWidth={1.5} />
        </button>
        <span style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 20, height: 20, borderRadius: 5, flexShrink: 0,
          background: `color-mix(in oklch, ${type.iconColor} 15%, transparent)`,
        }}>
          <type.icon size={12} color={type.iconColor} strokeWidth={1.5} />
        </span>
        <span style={{ fontSize: 14, fontWeight: 500 }}>{type.name}</span>
      </div>

      {/* Body — "px-4 py-4 flex flex-col gap-4" */}
      <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Input — shadcn Input h-9 text-sm */}
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={onKey}
          placeholder={`Untitled ${type.name}`}
          style={{
            width: "100%", height: 36,   // h-9 = 36px
            background: "transparent",
            border: "1px solid var(--input)",
            borderRadius: "var(--radius)",
            padding: "0 12px",
            fontSize: 14, outline: "none",
            color: "var(--foreground)",
            transition: "border-color 120ms, box-shadow 120ms",
          }}
          onFocus={e => { e.currentTarget.style.borderColor = "var(--ring)"; e.currentTarget.style.boxShadow = "0 0 0 3px color-mix(in oklch, var(--ring) 20%, transparent)"; }}
          onBlur={e => { e.currentTarget.style.borderColor = "var(--input)"; e.currentTarget.style.boxShadow = "none"; }}
        />

        {/* Footer row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <p style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
            Creating in: <span style={{ fontWeight: 500, color: "var(--foreground)" }}><ContextCrumbs crumbs={crumbs} /></span>
          </p>
          {/* Button size="sm" h-7 px-3 text-xs */}
          <button
            onClick={() => onCreate(name.trim() || `Untitled ${type.name}`)}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              height: 28, padding: "0 12px",
              borderRadius: "var(--radius)",
              fontSize: 12, fontWeight: 500,
              background: "var(--primary)", color: "var(--primary-foreground)",
              transition: "opacity 120ms",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.9"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
          >
            Create
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Success toast ────────────────────────────────────────────────────────────

function SuccessToast({ type, name, onDone }: { type: PageType; name: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 2000); return () => clearTimeout(t); }, [onDone]);
  return (
    <div style={{
      position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
      background: "var(--popover)", border: "1px solid var(--border)",
      borderRadius: "var(--radius)", padding: "10px 16px",
      display: "flex", alignItems: "center", gap: 10,
      boxShadow: "var(--shadow-elevated)",
      animation: "slideUp 180ms ease",
      zIndex: 100, whiteSpace: "nowrap",
    }}>
      <span style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 20, height: 20, borderRadius: 5,
        background: `color-mix(in oklch, ${type.iconColor} 15%, transparent)`,
      }}>
        <type.icon size={12} color={type.iconColor} strokeWidth={1.5} />
      </span>
      <span style={{ fontSize: 13 }}>
        <span style={{ color: "var(--muted-foreground)" }}>Created </span>
        <span style={{ fontWeight: 500 }}>{name}</span>
      </span>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "oklch(0.55 0.16 145)", flexShrink: 0 }} />
    </div>
  );
}

// ─── Palette (dialog shell) ───────────────────────────────────────────────────

function Palette({ crumbs, onClose }: { crumbs: BreadcrumbItem[]; onClose: () => void }) {
  const [phase, setPhase] = useState<"type-select" | "name-entry">("type-select");
  const [selectedType, setSelectedType] = useState<PageType | null>(null);
  const [lastCreated, setLastCreated] = useState<{ type: PageType; name: string } | null>(null);

  const handleSelect = (type: PageType) => { setSelectedType(type); setPhase("name-entry"); };
  const handleCreate = (name: string) => {
    if (!selectedType) return;
    setLastCreated({ type: selectedType, name });
    onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "oklch(0 0 0 / 0.5)", backdropFilter: "blur(2px)", zIndex: 10 }} />

      {/* Dialog shell — DialogContent "overflow-hidden p-0" + max-w-[480px] */}
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "fixed", top: "18%", left: "50%", transform: "translateX(-50%)",
          width: "calc(100vw - 32px)", maxWidth: 480,
          background: "var(--popover)", color: "var(--popover-foreground)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-elevated)",
          overflow: "hidden",
          zIndex: 20,
          animation: "popIn 140ms ease",
        }}
      >
        {phase === "type-select" && (
          <TypeSelect crumbs={crumbs} onSelect={handleSelect} onClose={onClose} />
        )}
        {phase === "name-entry" && selectedType && (
          <NameEntry type={selectedType} crumbs={crumbs} onBack={() => setPhase("type-select")} onCreate={handleCreate} onClose={onClose} />
        )}
      </div>

      {lastCreated && (
        <SuccessToast type={lastCreated.type} name={lastCreated.name} onDone={() => setLastCreated(null)} />
      )}
    </>
  );
}

// ─── Playground shell ─────────────────────────────────────────────────────────

export function QuickCreate() {
  const [open, setOpen] = useState(false);
  const [contextIndex, setContextIndex] = useState(0);
  const context = MOCK_CONTEXTS[contextIndex];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "n" || e.key === "N") && !open) { e.preventDefault(); setOpen(true); }
      if (e.key === "Escape" && open) setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 28, padding: 32 }}>
      <style>{`
        @keyframes popIn {
          from { opacity: 0; transform: translateX(-50%) scale(0.97) translateY(-6px); }
          to   { opacity: 1; transform: translateX(-50%) scale(1) translateY(0); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateX(-50%) translateY(6px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        input::placeholder { color: var(--muted-foreground); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
      `}</style>

      {/* Playground controls */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, maxWidth: 480, width: "100%", textAlign: "center" }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted-foreground)", marginBottom: 6, fontWeight: 600 }}>
            Quick Create Prototype
          </div>
          <div style={{ fontSize: 13, color: "var(--muted-foreground)", lineHeight: 1.6 }}>
            Press <strong style={{ color: "var(--foreground)" }}>⌥N</strong> or click below to open.
          </div>
        </div>

        {/* Context switcher */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, width: "100%" }}>
          <div style={{ fontSize: 11, color: "var(--muted-foreground)", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>
            Simulate location
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
            {MOCK_CONTEXTS.map((ctx, i) => (
              <button
                key={i}
                onClick={() => setContextIndex(i)}
                style={{
                  padding: "4px 12px", borderRadius: 20, fontSize: 12,
                  border: "1px solid",
                  borderColor: i === contextIndex ? "var(--ring)" : "var(--border)",
                  background: i === contextIndex ? `color-mix(in oklch, var(--ring) 15%, transparent)` : "transparent",
                  color: i === contextIndex ? "var(--primary)" : "var(--muted-foreground)",
                  transition: "all 120ms",
                }}
              >
                {ctx.label}
              </button>
            ))}
          </div>
        </div>

        {/* Trigger button — mirrors app sidebar "+" button */}
        <button
          onClick={() => setOpen(true)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            width: "100%", padding: "10px 14px",
            background: "var(--card)", border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: 14, color: "var(--muted-foreground)",
            transition: "border-color 120ms, background 120ms",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = `color-mix(in oklch, var(--border) 60%, var(--ring))`; (e.currentTarget as HTMLButtonElement).style.background = "var(--secondary)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)"; (e.currentTarget as HTMLButtonElement).style.background = "var(--card)"; }}
        >
          <span>New page…</span>
          <KbdHint keys={["⌥", "N"]} />
        </button>
      </div>

      {open && <Palette crumbs={context.crumbs} onClose={() => setOpen(false)} />}
    </div>
  );
}
