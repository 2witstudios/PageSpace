import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function IntegrationsPane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        Full integration framework.{" "}
        <span className="hl">4 providers, more coming.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        PageSpace has a production integration framework &mdash; not just
        hardcoded API calls, but a generic system with OAuth2/PKCE, API keys,
        bearer tokens, OpenAPI import, rate limiting, audit logging, and
        encrypted credentials. Agents access external APIs through tool grants
        with permission controls.
      </p>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Code: <code>packages/lib/src/integrations/</code> (37 files, fully tested)
      </p>

      <h3 style={{ marginBottom: 12 }}>Built-in providers</h3>
      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--green)"
          name="GitHub"
          description="Full OAuth2 integration. Repos, issues, PRs, commits. Agent can read code, create issues, review PRs. Production ready."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Google Calendar"
          description="OAuth2 with refresh tokens. Sync events, create events, attendees. Auto-sync every 5 minutes via cron. Push notifications for instant sync."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Slack (~1-2 days out)"
          description="OAuth2 adapter built and tested. Channels, messages, users. Key differentiator: bot runs with the requesting user's permissions in both PageSpace AND Slack. Same agent, two users, different access. Needs final UI wiring."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Notion"
          description="Provider adapter built. Pages, databases, blocks. Needs UI wiring and testing to go live."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>Integration framework</h3>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Auth methods</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            OAuth2 with PKCE, API keys (header/query/body), bearer tokens,
            basic auth, custom headers. Credentials encrypted at rest with
            AES-256-GCM. Token refresh handled automatically.
          </p>
        </Card>
        <Card accent="green">
          <h4>OpenAPI import</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Import any OpenAPI spec and PageSpace generates tool definitions
            automatically. Custom APIs become agent tools without writing
            adapter code. <code>converter/openapi.ts</code>
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Tool grants &amp; permissions</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            <code>integrationToolGrants</code> table controls which tools
            from a connection an agent can use. Admins grant specific tools
            to specific agents. Audit log tracks every external API call.
          </p>
        </Card>
        <Card accent="green">
          <h4>Rate limiting &amp; execution</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Per-integration rate limiter prevents API abuse. HTTP executor
            handles request/response with error mapping. Audit repository
            logs every call with duration, status, and error details.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Generic webhook</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Built-in generic webhook provider. Point it at any REST API
            with an API key or bearer token. No adapter code needed for
            simple integrations.
          </p>
        </Card>
        <Card accent="green">
          <h4>MCP (Model Context Protocol)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            MCP tokens with drive scoping for external access. Plus a
            <strong> full desktop MCP bridge</strong> &mdash; the Electron app
            spawns local Node-based MCP servers as child processes (stdio
            transport). Same config format as Claude Desktop and Cursor.
            Lifecycle management, crash recovery, tool caching, JSON-RPC,
            security validation, log rotation. Run any local MCP server and
            its tools become available to PageSpace agents.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── Gaps ── */}
      <div className="sl">Gaps</div>
      <h2>
        Framework is solid.{" "}
        <span className="hl">Provider coverage is thin.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The integration framework handles auth, execution, rate limiting,
        auditing, and permissions. The gap is breadth &mdash; only 2
        providers are fully live. The framework makes adding more fast,
        but each provider still needs an adapter, UI, and testing.
      </p>

      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--red)"
          name="Slack not live yet"
          description="Provider adapter is built and tested. OAuth scopes configured. Needs: UI for connecting, testing in production, documentation."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="Notion not live yet"
          description="Provider adapter is built and tested. Needs: UI for connecting, testing in production, page sync strategy."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No channel adapters"
          description="Agents can only be talked to via the PageSpace web UI. No way to interact with agents from Slack, Discord, email, or SMS."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="amber">
          <h4>No MCP server endpoint</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            PageSpace is an MCP client (connects to external MCP servers)
            but not an MCP server. External tools can&apos;t call PageSpace
            tools. This would let any MCP-compatible client (Claude Code,
            Cursor, etc.) use PageSpace&apos;s 33+ tools directly.
          </p>
        </Card>
        <Card accent="amber">
          <h4>No integration marketplace</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            OpenAPI import works but there&apos;s no browse/discover experience.
            Users need to find and paste OpenAPI specs manually. A marketplace
            of pre-built integrations would lower the barrier.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        Every API is an agent tool.{" "}
        <span className="hl">Four paths in.</span>
      </h2>

      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--cyan)"
          name="Native integrations"
          description="Built-in adapters: GitHub, Slack, Notion, Calendar, and more. OAuth flows in the UI. One-click connect."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="OpenAPI / webhook"
          description="Import any API via OpenAPI spec or generic webhook. Auth, rate limiting, and tool generation handled. No code."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Desktop MCP bridge"
          description="Run any Node-based MCP server locally via the Electron app. Tools become available to agents. Same config as Claude Desktop / Cursor."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--violet)"
          name="CLIs in containers"
          description="Install any CLI inside a Firecracker container. Agents use it via shell. If it has a CLI, agents can use it."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="blue">
          <h4>MCP server endpoint</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            PageSpace exposes its 33+ tools as an MCP server. Claude Code,
            Cursor, or any MCP client connects and gets full access to
            pages, search, tasks, agents &mdash; scoped by the connecting
            token&apos;s permissions.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Channel adapters</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Talk to PageSpace agents from Slack, Discord, email, SMS.
            Messages route to the right agent. Responses come back in the
            same channel. The agent doesn&apos;t know or care which channel
            the human is using.
          </p>
        </Card>
      </div>
      <div className="g2">
        <Card accent="blue">
          <h4>Integration marketplace</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Browse and discover pre-built integrations. One-click install.
            Community-contributed adapters. Each integration is just a
            provider config &mdash; pure data, no code to deploy.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Per-org integration governance</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Org admins control which integrations are available, which
            agents can use them, and set per-integration rate limits.
            Credential management at the org level, not per-user.
          </p>
        </Card>
      </div>
    </div>
  );
}
