import { useEffect, useMemo, useState } from "react";
import { buildClient, describeError, type DriveRow, type PageRow } from "./lib/pagespace";
import { Sidebar } from "./components/Sidebar";
import { ContentPanel } from "./components/ContentPanel";
import { TrashPanel } from "./components/TrashPanel";
import { MovePagePicker } from "./components/MovePagePicker";

const SIDEBAR_WIDTH_KEY = "pagespace-drive-ui.sidebarWidth";
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 480;
const DEFAULT_SIDEBAR_WIDTH = 300;

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function readStoredSidebarWidth(): number {
  const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : DEFAULT_SIDEBAR_WIDTH;
}

const ENV_TOKEN = import.meta.env.VITE_PAGESPACE_TOKEN ?? "";
// The real API sends no CORS headers, so a direct browser fetch to
// https://pagespace.ai is always blocked. In dev, route through Vite's
// same-origin proxy (see vite.config.ts) instead.
const ENV_API_URL =
  import.meta.env.VITE_PAGESPACE_API_URL ?? (import.meta.env.DEV ? window.location.origin : "https://pagespace.ai");

function pageRowFromDetails(details: { id: string; title: string | null; type: PageRow["type"]; children: unknown[] }): PageRow {
  return { id: details.id, title: details.title, type: details.type, hasChildren: details.children.length > 0, isTaskLinked: false };
}

function App() {
  const [apiUrl, setApiUrl] = useState(ENV_API_URL);
  const [token, setToken] = useState(ENV_TOKEN);
  const [drives, setDrives] = useState<DriveRow[]>([]);
  const [drivesError, setDrivesError] = useState<string | null>(null);
  const [driveRefreshKey, setDriveRefreshKey] = useState(0);
  const [selectedDriveId, setSelectedDriveId] = useState<string | null>(null);
  const [selectedPage, setSelectedPage] = useState<PageRow | null>(null);
  const [movingPage, setMovingPage] = useState<PageRow | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const [resizing, setResizing] = useState(false);
  // Bumped after a successful move/trash/restore — remounts <PageTree> so
  // affected locations re-fetch from scratch instead of needing cross-node
  // state surgery for an arbitrary source/destination pair.
  const [treeVersion, setTreeVersion] = useState(0);

  const client = useMemo(() => (token.trim() ? buildClient(apiUrl, token.trim()) : null), [apiUrl, token]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (!resizing) return;
    const handleMove = (e: PointerEvent) => setSidebarWidth(clampSidebarWidth(e.clientX));
    const handleUp = () => setResizing(false);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [resizing]);

  useEffect(() => {
    if (!client) {
      setDrives([]);
      setDrivesError(null);
      return;
    }
    let cancelled = false;
    setDrivesError(null);
    (async () => {
      try {
        const result = await client.drives.list({});
        if (cancelled) return;
        setDrives(result);
        setSelectedDriveId((prev) => (prev && result.some((d) => d.id === prev) ? prev : (result[0]?.id ?? null)));
      } catch (e) {
        if (!cancelled) setDrivesError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, driveRefreshKey]);

  const handleSelectDrive = (driveId: string) => {
    setSelectedDriveId(driveId);
    setSelectedPage(null);
    setShowTrash(false);
    setTreeVersion((v) => v + 1);
  };

  const handleMoved = () => {
    setMovingPage(null);
    setSelectedPage(null);
    setTreeVersion((v) => v + 1);
  };

  const handleTrashed = () => {
    setSelectedPage(null);
    setTreeVersion((v) => v + 1);
  };

  const handleNavigateBreadcrumb = async (id: string | null) => {
    if (!client) return;
    if (id === null) {
      setSelectedPage(null);
      return;
    }
    setNavError(null);
    try {
      const details = await client.pages.details({ pageId: id });
      setSelectedPage(pageRowFromDetails(details));
    } catch (e) {
      setNavError(describeError(e));
    }
  };

  const selectedDrive = drives.find((d) => d.id === selectedDriveId) ?? null;

  return (
    <div className="app-shell" style={resizing ? { cursor: "col-resize", userSelect: "none" } : undefined}>
      <Sidebar
        width={sidebarWidth}
        apiUrl={apiUrl}
        onApiUrlChange={setApiUrl}
        token={token}
        onTokenChange={setToken}
        envToken={!!ENV_TOKEN}
        client={client}
        drives={drives}
        drivesError={drivesError}
        selectedDriveId={selectedDriveId}
        onSelectDrive={handleSelectDrive}
        onDrivesChanged={() => setDriveRefreshKey((k) => k + 1)}
        selectedPageId={selectedPage?.id ?? null}
        onSelectPage={(p) => {
          setSelectedPage(p);
          setShowTrash(false);
        }}
        onMoveRequest={setMovingPage}
        treeVersion={treeVersion}
        showTrash={showTrash}
        onToggleTrash={() => setShowTrash((v) => !v)}
      />

      <div
        className={`sidebar-resizer${resizing ? " resizing" : ""}`}
        onPointerDown={(e) => {
          e.preventDefault();
          setResizing(true);
        }}
      />

      <main className="workspace">
        {!client && (
          <div className="workspace-empty">
            <p className="muted">Open the ⚙ connection settings and enter an API key to get started.</p>
          </div>
        )}

        {client && selectedDriveId && (
          <>
            {navError && <p className="error-text nav-error">{navError}</p>}
            {showTrash ? (
              <TrashPanel client={client} driveId={selectedDriveId} onRestored={() => setTreeVersion((v) => v + 1)} />
            ) : (
              <ContentPanel
                client={client}
                driveId={selectedDriveId}
                driveName={selectedDrive?.name ?? "Drive"}
                page={selectedPage}
                onOpenPage={setSelectedPage}
                onNavigateBreadcrumb={handleNavigateBreadcrumb}
                onRenamed={(title) => setSelectedPage((p) => (p ? { ...p, title } : p))}
                onMoveRequest={setMovingPage}
                onTrashed={handleTrashed}
              />
            )}
          </>
        )}
      </main>

      {client && movingPage && selectedDriveId && (
        <MovePagePicker
          client={client}
          driveId={selectedDriveId}
          page={movingPage}
          onClose={() => setMovingPage(null)}
          onMoved={handleMoved}
        />
      )}
    </div>
  );
}

export default App;
