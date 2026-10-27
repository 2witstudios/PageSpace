import type { CSSProperties } from "react";
import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";

const cellTd: CSSProperties = {
  padding: "8px 14px",
  borderBottom: "1px solid rgba(42,42,61,0.5)",
  fontSize: 12,
  verticalAlign: "top",
};

export function IntegrationsPane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        Production integration framework.{" "}
        <span className="hl">5 integrations, 48+ tools, MCP server.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        PageSpace has a complete integration infrastructure &mdash; not
        hardcoded API calls, but a generic system with OAuth2/PKCE,
        5 auth methods, OpenAPI import, encrypted credentials, distributed rate
        limiting, audit logging, and granular tool-level permissions.
        Agents access external APIs through tool grants with allow/deny
        controls per tool, per agent, per connection.
      </p>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Code: <code>packages/lib/src/integrations/</code> (56 files &mdash;
        28 source, 28 tests). Full UI:{" "}
        <code>apps/web/src/components/integrations/</code> (connect dialog,
        OpenAPI import, audit log, status badges, tool builder).
      </p>

      <h3 style={{ marginBottom: 12 }}>Integrations</h3>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--green)"
          name="GitHub &mdash; 27 tools"
          description="Full OAuth2. Repos, issues, PRs, commits, code search, discussions, team management. Read + write operations. 30 req/min rate limit. Production."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Google Calendar &mdash; dedicated"
          description="Separate OAuth2 implementation with push notifications. Auto-sync via webhook + cron fallback. Events map to pages. 9 dedicated API routes. Production."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Generic Webhook &mdash; 3 tools"
          description="Point at any REST API with API key or bearer token. POST, GET, and form POST. Custom headers. 60 req/min. No adapter code needed. Production."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--amber)"
          name="Slack &mdash; 7 tools"
          description="OAuth2 adapter fully built and tested. Channels, messages, users, send_message. Scopes configured. Generic connect UI works. Needs OAuth client setup in production environment."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Notion &mdash; 11 tools"
          description="OAuth2 adapter fully built and tested. Search, pages, databases, query, create, update. 180 req/min. Generic connect UI works. Needs OAuth client setup in production environment."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="OpenAPI Import"
          description="Import any OpenAPI 3.x spec (YAML/JSON). Auto-generates provider config with tool definitions, auth detection, parameter mapping. Full UI dialog. Production."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>Framework infrastructure</h3>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Auth methods (5)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            OAuth2 with PKCE (RFC 7636), API keys (header/query/body), bearer
            tokens, basic auth, custom headers. HMAC-SHA256 signed state with
            10-minute expiry for CSRF protection. Automatic token refresh.
          </p>
        </Card>
        <Card accent="green">
          <h4>Credential vault</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            AES-256-GCM encryption at rest for all credential values.
            Encrypted during connection creation, decrypted only during tool
            execution. User XOR drive scoping enforced by database CHECK
            constraint.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Tool grants &amp; permissions</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Two layers: page agents have <code>enabledTools</code> to
            restrict which native tools they get (the global assistant gets
            all 33+, but per-agent configs are lean). Integration tool grants
            add a second layer: per-agent, per-connection allow/deny lists,
            read-only mode, dangerous-tool lockout. Visibility scoping:
            private, owned drives, all drives.
          </p>
        </Card>
        <Card accent="green">
          <h4>Rate limiting &amp; audit</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Distributed rate limiting via Redis at tool, connection, drive, and
            provider levels (1&ndash;1000 req/min configurable). Complete audit
            log: every external API call logged with tool, agent, duration,
            status, and error details. 7 query functions.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>MCP server</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            PageSpace <strong>is</strong> an MCP server. WebSocket bridge at{" "}
            <code>/api/mcp-ws</code> with opaque token auth, session
            fingerprinting, connection health checks, message size validation.
            REST endpoints for drives and documents. Token management at{" "}
            <code>/api/auth/mcp-tokens</code>. External tools like Claude Code
            or Cursor can connect and access PageSpace capabilities.
          </p>
        </Card>
        <Card accent="green">
          <h4>Desktop MCP bridge</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Electron app spawns local Node-based MCP servers as child
            processes (stdio transport). Same config format as Claude Desktop /
            Cursor. Lifecycle management, crash recovery, tool caching,
            JSON-RPC 2.0, log rotation. Run any local MCP server and its tools
            become available to PageSpace agents.
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>Database schema (5 tables)</h3>
      <Card style={{ overflow: "auto", marginBottom: 12, padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)", width: "32%" }}>
                Table
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                Purpose
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--cyan)", fontFamily: "var(--mono)" }}>integrationProviders</td>
              <td style={cellTd}>Provider configs (builtin, openapi, custom, mcp, webhook). Stores OpenAPI specs. System vs. user-created.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--cyan)", fontFamily: "var(--mono)" }}>integrationConnections</td>
              <td style={cellTd}>Active connections with encrypted credentials. User XOR drive scoped. Status: active/expired/error/pending/revoked.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--cyan)", fontFamily: "var(--mono)" }}>integrationToolGrants</td>
              <td style={cellTd}>Per-agent, per-connection tool permissions. Allowed/denied tool lists, readOnly flag, rate limit overrides.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--cyan)", fontFamily: "var(--mono)" }}>globalAssistantConfig</td>
              <td style={cellTd}>Per-user assistant integration preferences. Drive overrides. Controls which integrations the global assistant can access.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--cyan)", fontFamily: "var(--mono)", borderBottom: "none" }}>integrationAuditLog</td>
              <td style={{ ...cellTd, borderBottom: "none" }}>Every external API call: tool, agent, user, duration, status, errors. Indexed for drive and temporal queries.</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <hr />

      {/* ── Competitive Context ── */}
      <div className="sl">Landscape</div>
      <h2>
        Integration breadth is a{" "}
        <span className="hl">counting game. MCP changes the rules.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Competitors claim thousands of integrations. But most inflate counts
        with browser automation targets and Zapier-style connectors. PageSpace
        has deep, native integrations &mdash; and MCP gives access to an
        ecosystem of 10K+ servers without writing adapter code.
      </p>

      <Card style={{ overflow: "auto", marginBottom: 12, padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)", width: "22%" }}>
                Platform
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)", width: "22%" }}>
                Claimed count
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                Reality
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Viktor AI</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>3,000+</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Browser automation + native APIs. Counts every app reachable via headless browser as an &ldquo;integration.&rdquo; Slack-native.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Lindy AI</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>5,000+</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Similar inflation &mdash; browser &ldquo;Computer Use&rdquo; for apps without APIs. Counts targets, not deep integrations.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>OpenFang</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>40 channels, 53 tools</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Agent OS in Rust. Native adapters for messaging, email, social, and developer channels. Strong breadth (Telegram, Discord, WhatsApp, Teams, IRC, Matrix, etc.)</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>OpenClaw</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>15+ channels, 50+ integrations</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Self-hosted AI gateway. Community extensions via ClawHub. Native channel adapters.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Slack</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>2,600+ apps</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Marketplace leader. Deep app ecosystem. But Slack is a messaging tool, not an OS.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Dust.tt</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>100+ integrations</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Native connectors (Slack, Notion, Google, Salesforce, GitHub) + MCP support. Closest comparable.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>MCP ecosystem</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>10,000+ servers</td>
              <td style={{ ...cellTd, color: "var(--mid)", borderBottom: "none" }}>Open standard. Adopted by Anthropic, OpenAI, Google, Microsoft. 97M+ monthly SDK downloads. Fastest-growing integration protocol.</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <Card accent="cyan">
        <h4 style={{ color: "var(--cyan)" }}>PageSpace&apos;s position</h4>
        <p style={{ fontSize: 12, marginTop: 4 }}>
          5 native integrations with 48+ deep tools, OpenAPI import for any
          API, MCP client and server for the 10K+ ecosystem.
          Small native count, but the framework means adding providers is fast
          and the MCP bridge gives instant breadth. The real differentiator:{" "}
          <strong>integrations run through the permission system</strong>
          &mdash; same agent, two users, different access. No competitor does
          per-user tool grants at the agent level.
        </p>
      </Card>

      <hr />

      {/* ── Gaps ── */}
      <div className="sl">Gaps</div>
      <h2>
        Framework is production-grade.{" "}
        <span className="hl">Breadth and channels are thin.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The infrastructure handles auth, encryption, execution, rate limiting,
        auditing, and permissions. The gaps are breadth (only 3 providers live
        in production, 2 pending deployment) and surface area (agents only
        reachable via the web UI).
      </p>

      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--amber)"
          name="Slack &amp; Notion not deployed"
          description="Adapters built and tested. Generic connect UI works. Need OAuth client credentials configured in production and end-to-end validation."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No channel adapters"
          description="Agents are only reachable via the PageSpace web UI. No way to talk to agents from Slack, Discord, email, SMS, or WhatsApp. Other platforms support 40+ channel adapters."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="Thin native provider count"
          description="4 built-in providers vs. competitors claiming thousands. OpenAPI import and MCP bridge close the gap, but browse/discover experience is missing."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="amber">
          <h4>No integration marketplace</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            OpenAPI import works and has a full UI dialog, but there&apos;s no
            browse/discover experience. Users must find and paste specs
            manually. A marketplace of pre-built provider configs would lower
            the barrier to one click.
          </p>
        </Card>
        <Card accent="amber">
          <h4>No inbound webhook triggers</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            PageSpace can call external APIs (outbound) but external services
            can&apos;t trigger agent actions via webhooks (inbound). Google
            Calendar has a dedicated webhook receiver &mdash; the pattern
            exists but isn&apos;t generic yet.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        Every API is an agent tool.{" "}
        <span className="hl">Five paths in.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The integration framework and MCP server already exist. The end game
        is breadth, surface area, and governance &mdash; turning PageSpace
        from a platform agents use into a platform agents live across.
        Aligned with the roadmap: infrastructure first, then surfaces.
      </p>

      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--cyan)"
          name="Native integrations"
          description="Built-in adapters for the top 20: GitHub, Slack, Notion, Calendar, Jira, Linear, HubSpot, Salesforce, Stripe, and more. One-click OAuth. Adapter + UI takes days, not months &mdash; the framework handles the hard parts."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="MCP ecosystem (10K+)"
          description="Already an MCP client and server. With 10,000+ MCP servers in the ecosystem, any tool with an MCP server is instantly available. Datadog, Stripe, Cloudflare, Linear, Sentry &mdash; no adapter code needed."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="OpenAPI / webhook"
          description="Import any API via OpenAPI spec. Auth detection, parameter mapping, tool generation &mdash; all automatic. Generic webhook for simple REST APIs. Already in production."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>
      <FeatureRow columns={2}>
        <Feature
          nameColor="var(--violet)"
          name="CLIs in containers"
          description="Install any CLI inside a Firecracker VM. Agents use it via shell. Terraform, kubectl, aws-cli, gh, any tool that has a CLI becomes an agent capability. Depends on the runtime + container layer from the roadmap."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--blue)"
          name="Channel adapters"
          description="Talk to PageSpace agents from Slack, Discord, email, SMS, WhatsApp. Messages route to the right agent. Responses come back in the same channel. The agent doesn't know or care which surface the human is using."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="blue">
          <h4>Integration marketplace</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Browse and discover pre-built integrations. One-click install.
            Community-contributed provider configs + MCP server directory.
            Each integration is pure data &mdash; no code to deploy. The
            OpenAPI import and provider system already support this; the
            marketplace is the discovery layer on top.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Inbound webhook engine</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Generic inbound webhooks that trigger agent actions. GitHub push
            &rarr; agent reviews code. Stripe payment &rarr; agent provisions
            account. Sentry alert &rarr; agent investigates. The Calendar
            webhook pattern generalised to any event source.
          </p>
        </Card>
      </div>
      <div className="g2">
        <Card accent="blue">
          <h4>Per-org integration governance</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Org admins control which integrations are available, which agents
            can use them, and set per-integration rate limits. Credential
            management at the org level, not per-user. The{" "}
            <code>globalAssistantConfig</code> table already supports
            per-user + drive overrides &mdash; extend to org-level policies.
          </p>
        </Card>
        <Card accent="blue">
          <h4>The drive becomes memory that executes</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            A drive already holds everything an agent knows &mdash; pages,
            data, permissions, context. Containers make it a drive that
            <em> runs</em>. Integrations make it a drive that
            <em> reaches out</em>. The drive isn&apos;t storage you connect
            to external systems &mdash; it&apos;s a living environment where
            agents think, execute, and interact with the outside world.
            That&apos;s the end game: the drive is the agent&apos;s brain,
            body, and voice.
          </p>
        </Card>
      </div>
    </div>
  );
}
