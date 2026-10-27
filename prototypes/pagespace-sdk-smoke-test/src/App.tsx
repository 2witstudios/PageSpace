import { useState } from "react";
import {
  PageSpaceClient,
  StaticTokenProvider,
  isPageSpaceError,
  SDK_VERSION,
  type PageSpaceError,
} from "@pagespace/sdk";
import "./App.css";

type TestStatus = "pending" | "running" | "pass" | "fail" | "skipped";

interface TestResult {
  name: string;
  status: TestStatus;
  detail: string;
  ms?: number;
}

type Ctx = {
  driveId?: string;
  pageId?: string;
  agentId?: string;
  documentPageId?: string;
};

function describeError(error: unknown): string {
  if (isPageSpaceError(error)) {
    const e = error as PageSpaceError;
    return `${e.code}: ${e.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function preview(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (!json) return String(value);
  return json.length > 500 ? json.slice(0, 500) + "\n… (truncated)" : json;
}

// Each test may read/write `ctx` so later tests (e.g. pages.list) can reuse
// ids discovered by earlier ones (e.g. drives.list) — same chaining a real
// consumer app would do, not synthetic fixtures.
function buildReadOnlyTests(
  client: PageSpaceClient,
  ctx: Ctx,
): { name: string; run: () => Promise<string> }[] {
  return [
    {
      name: "drives.list",
      run: async () => {
        const drives = await client.drives.list({});
        if (drives.length > 0) ctx.driveId = drives[0].id;
        return `${drives.length} drive(s) visible. ${preview(drives.slice(0, 3))}`;
      },
    },
    {
      name: "pages.list",
      run: async () => {
        if (!ctx.driveId) throw new Error("no driveId (drives.list must run first)");
        const result = await client.pages.list({ driveId: ctx.driveId, ls: true });
        // Prefer a non-CHANNEL/TASK_LIST page so pages.read below exercises
        // the generic branch (DOCUMENT/FOLDER/CANVAS/CODE) that 1.5.1 fixed.
        const preferred = result.pages.find((p) => !["CHANNEL", "TASK_LIST"].includes(p.type)) ?? result.pages[0];
        if (preferred) ctx.pageId = preferred.id;
        return `drive "${result.driveName}", ${result.pages.length} top-level page(s). ${preview(result.pages.slice(0, 3))}`;
      },
    },
    {
      name: "pages.read (fixed in 1.5.1)",
      run: async () => {
        if (!ctx.pageId) return "skipped: no page found to read";
        const result = await client.pages.read({ operation: "read", pageId: ctx.pageId });
        const lines = "totalLines" in result ? result.totalLines : "?";
        return `read ok — ${lines} line(s). ${preview(result)}`;
      },
    },
    {
      name: "activity.get",
      run: async () => {
        const result = await client.activity.get({ context: "user", limit: 5 });
        return preview(result);
      },
    },
    {
      name: "calendar.list",
      run: async () => {
        const now = new Date();
        const start = new Date(now);
        start.setDate(start.getDate() - 7);
        const end = new Date(now);
        end.setDate(end.getDate() + 7);
        const result = await client.calendar.list({
          context: "user",
          startDate: start.toISOString(),
          endDate: end.toISOString(),
        });
        return `${result.events.length} event(s), ${result.workflowEvents.length} workflow event(s) in the +/-7 day window.`;
      },
    },
    {
      name: "collaborators.list",
      run: async () => {
        const result = await client.collaborators.list({});
        return `${result.connections.length} connection(s).`;
      },
    },
    {
      name: "search.glob",
      run: async () => {
        if (!ctx.driveId) throw new Error("no driveId (drives.list must run first)");
        // maxResults 200 (the API's cap) rather than a small preview count — this
        // search doubles as how export.pageMarkdown below finds a real DOCUMENT
        // page, which a small sample would likely miss in a drive full of other
        // page types (channels, task lists, folders).
        const result = await client.search.glob({ driveId: ctx.driveId, pattern: "**/*", maxResults: 200 });
        const document = result.results.find((r) => r.type === "DOCUMENT");
        if (document) ctx.documentPageId = document.pageId;
        return preview({ ...result, results: result.results.slice(0, 3) });
      },
    },
    {
      name: "roles.list",
      run: async () => {
        if (!ctx.driveId) throw new Error("no driveId (drives.list must run first)");
        const result = await client.roles.list({ driveId: ctx.driveId });
        return `${result.roles.length} custom role(s).`;
      },
    },
    {
      name: "members.list",
      run: async () => {
        if (!ctx.driveId) throw new Error("no driveId (drives.list must run first)");
        const result = await client.members.list({ driveId: ctx.driveId });
        return `${result.members.length} member(s), your role: ${result.currentUserRole}.`;
      },
    },
    {
      name: "agents.list",
      run: async () => {
        if (!ctx.driveId) throw new Error("no driveId (drives.list must run first)");
        const result = await client.agents.list({ driveId: ctx.driveId });
        const agents = (result as { agents?: { id: string }[] }).agents ?? [];
        if (agents[0]) ctx.agentId = agents[0].id;
        return `${agents.length} agent(s) in this drive.`;
      },
    },
    {
      name: "conversations.list",
      run: async () => {
        if (!ctx.agentId) return "skipped: no agent found in this drive to list conversations for";
        const result = await client.conversations.list({ agentId: ctx.agentId });
        const conversations = (result as { conversations?: unknown[] }).conversations ?? [];
        return `${conversations.length} conversation(s) for agent ${ctx.agentId}.`;
      },
    },
    {
      name: "export.pageMarkdown",
      run: async () => {
        // Markdown export only accepts DOCUMENT pages — ctx.pageId (from pages.list)
        // is whatever generic page pages.read exercised, which may be a
        // FOLDER/CANVAS/CODE page instead. Prefer the DOCUMENT page search.glob
        // found, and only fall back to ctx.pageId (and risk a real 400) if this
        // drive has no DOCUMENT page at all.
        const targetId = ctx.documentPageId ?? ctx.pageId;
        if (!targetId) return "skipped: no page found in this drive to export";
        const markdown = await client.export.pageMarkdown({ pageId: targetId });
        return `exported ${markdown.length} chars of markdown.`;
      },
    },
    {
      name: "workflows.list",
      run: async () => {
        if (!ctx.driveId) throw new Error("no driveId (drives.list must run first)");
        const workflows = await client.workflows.list({ driveId: ctx.driveId });
        return `${workflows.length} workflow(s). (requires drive:admin — a 403 here just means your key isn't admin on this drive)`;
      },
    },
    {
      name: "commands.list",
      run: async () => {
        const result = await client.commands.list({});
        return `${result.commands.length} command(s). (requires 'account' scope — a 403 here just means your key is drive-scoped, not account-scoped)`;
      },
    },
    {
      name: "tokens.list",
      run: async () => {
        // Unlike commands.list, this route rejects a non-account-scoped key with
        // a hard 401 rather than a 403 — the SDK's static-token auth provider
        // maps every 401 to the same AuthenticationError (it has no way to tell
        // "scope too narrow" apart from "token actually revoked"), so that's the
        // signal we key off here. A drive-scoped key hitting this is expected,
        // not a real SDK failure.
        try {
          const tokens = await client.tokens.list({});
          return `${tokens.length} MCP key(s) on this account. (requires 'account' scope, same caveat as commands.list)`;
        } catch (error) {
          if (isPageSpaceError(error) && error.code === "AUTHENTICATION_ERROR") {
            return "skipped: requires an account-scoped key (this key is drive-scoped)";
          }
          throw error;
        }
      },
    },
  ];
}

const ENV_TOKEN = import.meta.env.VITE_PAGESPACE_TOKEN ?? "";
// The real API sends no CORS headers, so a direct browser fetch to
// https://pagespace.ai is always blocked. In dev, route through Vite's
// same-origin proxy (see vite.config.ts) instead — same real production
// API, just no browser-enforced CORS block on the request.
const ENV_API_URL =
  import.meta.env.VITE_PAGESPACE_API_URL ?? (import.meta.env.DEV ? window.location.origin : "https://pagespace.ai");

function App() {
  const [apiUrl, setApiUrl] = useState(ENV_API_URL);
  const [token, setToken] = useState(ENV_TOKEN);
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [mutationResult, setMutationResult] = useState<TestResult | null>(null);
  const [mutationRunning, setMutationRunning] = useState(false);

  const runAll = async () => {
    if (!token.trim()) return;
    setRunning(true);
    setResults([]);
    console.log('DEBUG apiUrl:', JSON.stringify(apiUrl), 'token len:', token.trim().length);
    const client = new PageSpaceClient({ baseUrl: apiUrl, auth: new StaticTokenProvider(token.trim()) });
    try {
      const testFetch = await fetch(`${apiUrl}/api/drives`, { headers: { Authorization: `Bearer ${token.trim()}` } });
      console.log('DEBUG manual fetch status:', testFetch.status);
    } catch (e) {
      console.log('DEBUG manual fetch threw:', String(e));
    }
    const ctx: Ctx = {};
    const tests = buildReadOnlyTests(client, ctx);

    for (const test of tests) {
      setResults((prev) => [...prev, { name: test.name, status: "running", detail: "" }]);
      const started = performance.now();
      try {
        const detail = await test.run();
        const ms = Math.round(performance.now() - started);
        const skipped = detail.startsWith("skipped:");
        setResults((prev) =>
          prev.map((r) => (r.name === test.name ? { name: test.name, status: skipped ? "skipped" : "pass", detail, ms } : r)),
        );
      } catch (error) {
        const ms = Math.round(performance.now() - started);
        setResults((prev) =>
          prev.map((r) => (r.name === test.name ? { name: test.name, status: "fail", detail: describeError(error), ms } : r)),
        );
      }
    }
    setRunning(false);
  };

  const runMutationTest = async () => {
    if (!token.trim()) return;
    setMutationRunning(true);
    const client = new PageSpaceClient({ baseUrl: apiUrl, auth: new StaticTokenProvider(token.trim()) });
    const started = performance.now();
    try {
      const drives = await client.drives.list({});
      if (drives.length === 0) throw new Error("no drives visible to this key");
      const driveId = drives[0].id;
      const title = `sdk-smoke-test ${new Date().toISOString()}`;
      const createdPage = await client.pages.create({ driveId, title, type: "DOCUMENT" });
      await client.pages.trash({ pageId: createdPage.id, trash_children: false });
      const ms = Math.round(performance.now() - started);
      setMutationResult({
        name: "pages.create + pages.trash",
        status: "pass",
        detail: `Created page "${title}" (${createdPage.id}) in drive ${driveId}, then trashed it. Round-trip clean.`,
        ms,
      });
    } catch (error) {
      const ms = Math.round(performance.now() - started);
      setMutationResult({ name: "pages.create + pages.trash", status: "fail", detail: describeError(error), ms });
    }
    setMutationRunning(false);
  };

  return (
    <div className="app">
      <header>
        <h1>@pagespace/sdk smoke test</h1>
        <p className="sub">
          Installed from npm as a real consumer would (<code>@pagespace/sdk@{SDK_VERSION}</code>), not linked against
          the monorepo workspace.
        </p>
      </header>

      <section className="config">
        <label>
          API URL
          <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
        </label>
        <label>
          Token
          {ENV_TOKEN ? (
            <div className="env-token-badge">
              <span className="badge badge-env">from .env.local</span>
              <code>PAGESPACE_TOKEN={ENV_TOKEN.slice(0, 8)}…{ENV_TOKEN.slice(-4)}</code>
            </div>
          ) : (
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="mcp_... (no VITE_PAGESPACE_TOKEN found in env)"
            />
          )}
        </label>
        <button disabled={!token.trim() || running} onClick={runAll}>
          {running ? "Running…" : "Run read-only diagnostics"}
        </button>
      </section>

      <section className="results">
        {results.map((r) => (
          <div key={r.name} className={`result result-${r.status}`}>
            <div className="result-head">
              <span className="badge">{r.status}</span>
              <span className="name">{r.name}</span>
              {r.ms !== undefined && <span className="ms">{r.ms}ms</span>}
            </div>
            {r.detail && <pre>{r.detail}</pre>}
          </div>
        ))}
      </section>

      <section className="mutation">
        <h2>Write-path test (opt-in)</h2>
        <p>Creates one real page named "sdk-smoke-test …" in your first visible drive, then immediately trashes it.</p>
        <button disabled={!token.trim() || mutationRunning} onClick={runMutationTest}>
          {mutationRunning ? "Running…" : "Run pages.create + pages.trash"}
        </button>
        {mutationResult && (
          <div className={`result result-${mutationResult.status}`}>
            <div className="result-head">
              <span className="badge">{mutationResult.status}</span>
              <span className="name">{mutationResult.name}</span>
              {mutationResult.ms !== undefined && <span className="ms">{mutationResult.ms}ms</span>}
            </div>
            <pre>{mutationResult.detail}</pre>
          </div>
        )}
      </section>
    </div>
  );
}

export default App;
