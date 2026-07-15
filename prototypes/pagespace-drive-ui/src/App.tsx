import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  FileText,
  Moon,
  Settings2,
  ShieldCheck,
  Sun,
  X,
} from "lucide-react";
import { buildClient, describeError, type DriveRow } from "./lib/pagespace";
import { config, type ViewMode } from "./lib/config";
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
  const [agentId, setAgentId] = useState<string | null>(config.agentId || null);
  const [mode, setMode] = useState<ViewMode>("ask");
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

  // Resolve the agent page for this drive (env override, else first AI_CHAT).
  useEffect(() => {
    if (!client || !driveId || config.agentId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await client.pages.list({ driveId, recursive: true, ls: true });
        if (cancelled) return;
        setAgentId(res.pages.find((p) => p.type === "AI_CHAT")?.id ?? null);
      } catch {
        /* leave agent null; chat surface shows a friendly disabled state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, driveId]);

  const activeDrive = drives.find((d) => d.id === driveId) ?? null;
  const canManage = activeDrive?.role === "OWNER" || activeDrive?.role === "ADMIN";
  const effectiveMode: ViewMode = mode === "manage" && !canManage ? "ask" : mode;

  const tabs: { key: ViewMode; label: string; icon: typeof Bot }[] = [
    { key: "ask", label: "Ask", icon: Bot },
    { key: "docs", label: "Docs", icon: FileText },
    ...(canManage ? [{ key: "manage" as const, label: "Manage", icon: ShieldCheck }] : []),
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
                onClick={() => setMode(tab.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  effectiveMode === tab.key
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
          {canManage && (
            <span className="mr-1 hidden items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground sm:flex">
              <ShieldCheck className="size-3.5 text-success" /> Admin
            </span>
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
        ) : effectiveMode === "ask" ? (
          <AskView apiUrl={apiUrl} token={token.trim()} agentId={agentId} botName={`${config.botName} Assistant`} />
        ) : effectiveMode === "docs" ? (
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
