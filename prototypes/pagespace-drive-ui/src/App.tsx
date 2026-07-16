import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Eye,
  FileText,
  Moon,
  Settings2,
  ShieldCheck,
  Sun,
  X,
} from "lucide-react";
import { buildClient, describeError, type DriveRow } from "./lib/pagespace";
import { config, type Section, type Audience } from "./lib/config";
import { AskView } from "./components/AskView";
import { DocsView } from "./components/DocsView";
import { ManageView } from "./components/ManageView";
import { Button, Input } from "./components/ui";
import { cn } from "./lib/cn";

const THEME_KEY = "pagespace-support.theme";

function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
}

export default function App() {
  const [apiUrl] = useState(config.apiUrl);
  const [token, setToken] = useState(config.token);
  const [drives, setDrives] = useState<DriveRow[]>([]);
  const [driveId, setDriveId] = useState(config.driveId);
  const [audience, setAudience] = useState<Audience>("visitor");
  const [section, setSection] = useState<Section>("ask");
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem(THEME_KEY) === "dark");

  useEffect(() => applyTheme(dark), [dark]);

  const client = useMemo(() => (token.trim() ? buildClient(apiUrl, token.trim()) : null), [apiUrl, token]);

  // Load drives, pick the active one, learn our role.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await client.drives.list({});
        if (cancelled) return;
        setDrives(list);
        setDriveId((cur) => cur || list[0]?.id || "");
        setError(null);
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const activeDrive = drives.find((d) => d.id === driveId) ?? null;
  const canBeAdmin = activeDrive?.role === "OWNER" || activeDrive?.role === "ADMIN";
  // Non-admins can only ever be a visitor; the admin view is gated by drive role.
  const effAudience: Audience = audience === "admin" && !canBeAdmin ? "visitor" : audience;
  const effSection: Section = section === "manage" && effAudience !== "admin" ? "ask" : section;

  const tabs: { key: Section; label: string; icon: typeof Bot }[] = [
    { key: "ask", label: "Ask", icon: Bot },
    { key: "docs", label: "Docs", icon: FileText },
    ...(effAudience === "admin" ? [{ key: "manage" as const, label: "Manage", icon: ShieldCheck }] : []),
  ];

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Header */}
      <header className="liquid-glass z-10 flex h-14 shrink-0 items-center gap-4 border-b border-border px-4">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Bot className="size-4.5" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">{config.botName} Assistant</div>
            <div className="text-[11px] text-muted-foreground">
              {activeDrive?.name ? `${activeDrive.name} · on PageSpace` : "on PageSpace"}
            </div>
          </div>
        </div>

        {client && (
          <nav className="ml-2 flex items-center gap-1 rounded-lg bg-muted/60 p-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setSection(tab.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  effSection === tab.key
                    ? "bg-card text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <tab.icon className="size-4" />
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-1">
          {canBeAdmin && (
            <div className="mr-1 hidden items-center rounded-lg border border-border p-0.5 sm:flex" title="Preview the site as a public visitor, or as the drive admin">
              {(["visitor", "admin"] as const).map((a) => (
                <button
                  key={a}
                  onClick={() => setAudience(a)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    effAudience === a ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {a === "visitor" ? <Eye className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
                  {a === "visitor" ? "Visitor" : "Admin"}
                </button>
              ))}
            </div>
          )}
          <Button variant="ghost" size="icon" onClick={() => setDark((d) => !d)} title="Toggle theme">
            {dark ? <Sun /> : <Moon />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)} title="Settings">
            <Settings2 />
          </Button>
        </div>
      </header>

      {/* Body */}
      <main className="min-h-0 flex-1">
        {!client ? (
          <ConnectScreen token={token} onConnect={setToken} error={error} />
        ) : error && drives.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-md rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-sm text-destructive">
              {error}
            </div>
          </div>
        ) : effSection === "ask" ? (
          <AskView
            chat={
              effAudience === "admin"
                ? { kind: "direct", apiUrl, token: token.trim(), agentId: config.ownerAgentId || null }
                : { kind: "proxy" }
            }
            botName={effAudience === "admin" ? "Docs Editor" : `${config.botName} Assistant`}
          />
        ) : effSection === "docs" ? (
          driveId ? <DocsView client={client} driveId={driveId} /> : null
        ) : driveId ? (
          <ManageView client={client} driveId={driveId} />
        ) : null}
      </main>

      {settingsOpen && (
        <SettingsPanel
          token={token}
          onToken={setToken}
          drives={drives}
          driveId={driveId}
          onDrive={setDriveId}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function ConnectScreen({
  token,
  onConnect,
  error,
}: {
  token: string;
  onConnect: (t: string) => void;
  error: string | null;
}) {
  const [value, setValue] = useState(token);
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Bot className="size-6" />
        </div>
        <h1 className="text-lg font-semibold">Connect to PageSpace</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste a drive-scoped <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">mcp_</code> token. Mint
          one with <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">pagespace keys create</code>.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onConnect(value.trim());
          }}
          className="mt-4 flex flex-col gap-3"
        >
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="mcp_…"
            type="password"
            autoFocus
          />
          <Button type="submit" disabled={!value.trim()}>
            Connect
          </Button>
        </form>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}

function SettingsPanel({
  token,
  onToken,
  drives,
  driveId,
  onDrive,
  onClose,
}: {
  token: string;
  onToken: (t: string) => void;
  drives: DriveRow[];
  driveId: string;
  onDrive: (id: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(token);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-sm flex-col border-l border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Settings</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="flex flex-col gap-5 p-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Token</label>
            <Input value={value} onChange={(e) => setValue(e.target.value)} type="password" placeholder="mcp_…" />
            <Button size="sm" className="mt-1" onClick={() => onToken(value.trim())}>
              Apply token
            </Button>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Drive</label>
            <select
              value={driveId}
              onChange={(e) => onDrive(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            >
              {drives.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.role.toLowerCase()})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
