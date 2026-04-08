import type { CSSProperties } from "react";
import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";
import { DataTable, CompareRow, SectionHeader } from "../ui/DataTable";
import { Zone, Svc, Flow, CronJob } from "../ui/InfraHelpers";

const analogyTd: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid rgba(42,42,61,0.5)",
  verticalAlign: "top",
  fontSize: 12,
};

export function StoryPane() {
  return (
    <div className="pane-wide">
      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 1: What PageSpace is                           */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">What PageSpace is</div>
      <h2>
        A cloud operating system{" "}
        <span className="hl">for agents and people.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Not a document editor. Not a chatbot wrapper. An <strong>operating
        system</strong> &mdash; with a filesystem (pages), permissions (RBAC),
        processes (agents), networking (real-time), and storage (Postgres).
        People and agents share the same environment. Two things are missing
        to complete the picture.
      </p>

      <Card style={{ overflow: "auto", marginBottom: 28, padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                OS concept
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                PageSpace equivalent
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                Details
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...analogyTd, fontWeight: 600, color: "var(--text)" }}>Filesystem</td>
              <td style={{ ...analogyTd, color: "var(--green)" }}>Pages</td>
              <td style={{ ...analogyTd, color: "var(--mid)" }}>9 page types, tree hierarchy, drives as volumes</td>
            </tr>
            <tr>
              <td style={{ ...analogyTd, fontWeight: 600, color: "var(--text)" }}>Permissions</td>
              <td style={{ ...analogyTd, color: "var(--green)" }}>RBAC</td>
              <td style={{ ...analogyTd, color: "var(--mid)" }}>Owner/Admin/Member + page-level canView/canEdit/canShare/canDelete</td>
            </tr>
            <tr>
              <td style={{ ...analogyTd, fontWeight: 600, color: "var(--text)" }}>Processes</td>
              <td style={{ ...analogyTd, color: "var(--green)" }}>Agents</td>
              <td style={{ ...analogyTd, color: "var(--mid)" }}>AI Chat pages with 33+ tools, agent-to-agent delegation</td>
            </tr>
            <tr>
              <td style={{ ...analogyTd, fontWeight: 600, color: "var(--text)" }}>Networking</td>
              <td style={{ ...analogyTd, color: "var(--green)" }}>Socket.IO</td>
              <td style={{ ...analogyTd, color: "var(--mid)" }}>Real-time collaboration, presence, per-event auth</td>
            </tr>
            <tr>
              <td style={{ ...analogyTd, fontWeight: 600, color: "var(--text)" }}>Storage</td>
              <td style={{ ...analogyTd, color: "var(--green)" }}>Postgres</td>
              <td style={{ ...analogyTd, color: "var(--mid)" }}>89 tables, Drizzle ORM, file processing pipeline</td>
            </tr>
          </tbody>
        </table>
      </Card>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 2: The two gaps                                */}
      {/* ═══════════════════════════════════════════════════════ */}

      <FeatureRow columns={2}>
        <Feature
          icon="&#x1F527;"
          nameColor="var(--amber)"
          name="Gap 1: Agents can't loop or run autonomously"
          description="PageSpace AI is more than single-turn &mdash; agents make multiple tool calls per request, delegate to other agents via <code>ask_agent</code>, and manage tasks across conversations. But execution is <strong style='color:var(--text)'>request-bound</strong>: a human must initiate it. Agents can't plan, evaluate, retry, schedule themselves, or operate at the CLI/shell level. The gap isn't &lsquo;no intelligence&rsquo; &mdash; it's no autonomous loop and no real execution environment."
        />
        <Feature
          icon="&#x1F4BB;"
          nameColor="var(--blue)"
          name="Gap 2: It can't build software"
          description="PageSpace stores data but can't run code. Once it can &mdash; once it has containers, a filesystem, git, and a build pipeline &mdash; it becomes a <strong style='color:var(--text)'>computer, not a document editor.</strong> Imagine Google Drive as a computer that can launch apps with your Drive data. That's the target. PageSpace builds software using its own data, including building its own interfaces."
        />
      </FeatureRow>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 3: The complete OS                             */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">The complete OS</div>
      <h2>
        Fill the gaps and PageSpace{" "}
        <span className="hl">builds itself.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        An OS has a filesystem, processes, permissions, networking, and the
        ability to run programs. PageSpace already has most of this. Add a
        real process model (CLI agents) and the ability to run code
        (containers), and it becomes self-extending &mdash; the OS starts
        building its own apps, interfaces, and tools from the inside.
      </p>

      <FeatureRow>
        <Feature
          icon="&#x1F527;"
          nameColor="var(--cyan)"
          name="CLI-based agent runtime"
          description="Agents run in containers with real shells, real git, real filesystems. Not tool calls &mdash; actual CLI execution. They schedule themselves, react to triggers, and run autonomously. Always-on, not just chat."
        />
        <Feature
          icon="&#x1F4C4;"
          nameColor="var(--green)"
          name="Everything is a page"
          description="Pages are the universal primitive. Agents are pages. Sub-agents are child pages. Skills are pages. The page tree IS the agent hierarchy. Same permissions, same collaboration, same search."
        />
        <Feature
          icon="&#x1F680;"
          nameColor="var(--violet)"
          name="Apps from your data"
          description="A repo in PageSpace is a drive. Build it and it's a deployable app &mdash; backed by the same Postgres your team works in. CMS, CRM, dashboards, internal tools &mdash; not separate products, just apps launched from PageSpace data."
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="amber">
          <h4 style={{ color: "var(--amber)" }}>Today: most of an OS</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Filesystem (pages), permissions (RBAC), networking (Socket.IO),
            storage (Postgres), user space (drives). Multi-tool agents with
            delegation, task management, and workflow scheduling. But execution
            is request-bound &mdash; no autonomous loops, no containers, no
            shell access.
          </p>
        </Card>
        <Card accent="cyan">
          <h4 style={{ color: "var(--cyan)" }}>Target: a complete OS</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Add CLI agents (processes) and containers (execution). Now
            the OS runs programs on its own data. Agents build apps,
            deploy sites, automate workflows &mdash; all inside
            PageSpace. The OS starts extending itself.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)" }}>
        <h4 style={{ color: "var(--blue)" }}>Why both gaps matter together</h4>
        <p style={{ fontSize: 12 }}>
          A runtime without code execution is just a chatbot. Code execution
          without a runtime is just a hosted IDE. Together they create
          something new: a platform where your data, your agents, and your
          apps all live in the same place. A repo inside PageSpace is a
          drive (for the team) and a deployable app (built by agents) at the
          same time. The platform starts building its own interfaces,
          its own tools, its own workflows &mdash; from the inside.
        </p>
      </Card>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 4: Today's infrastructure                      */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Today's infrastructure</div>
      <h2>
        Single VPS. Single Postgres.{" "}
        <span className="hl">8 containers.</span>
      </h2>
      <h3 style={{ marginBottom: 16 }}>
        <span style={{ color: "var(--dim)", fontWeight: 400 }}>No agent runtime, no container execution, no org isolation.</span>
      </h3>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20, alignItems: "start" }}>
        <div style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: 14, padding: 16 }}>

          <Zone label="Caddy" color="var(--green)" badge="reverse proxy . :443">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
              <Svc name="/" detail="-> Web :3000" color="var(--green)" />
              <Svc name="/socket.io/*" detail="-> Realtime :3001" color="var(--cyan)" />
              <Svc name="/_marketing/*" detail="-> Marketing :3004" color="var(--amber)" />
              <Svc name="/api/cron/*" detail="-> 403 Blocked" color="var(--red)" />
            </div>
          </Zone>

          <Flow label="docker networks" />

          <Zone label="Docker Compose" color="var(--blue)" badge="single VPS">
            <Zone label="Frontend Network" color="var(--cyan)" badge="exposed to Caddy" style={{ marginBottom: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 6 }}>
                <Svc name="Web (Next.js)" detail="API routes . AI chat . 33+ tools . Brave search" color="var(--cyan)" port=":3000" mem="768M" />
                <Svc name="Realtime" detail="Socket.IO . presence . per-event auth" color="var(--cyan)" port=":3001" mem="256M" />
                <Svc name="Marketing" detail="Landing pages . docs . pricing" color="var(--cyan)" port=":3004" mem="256M" />
              </div>
            </Zone>
            <Zone label="Internal Network" color="var(--violet)" badge="no external access">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 6 }}>
                <Svc name="PostgreSQL 17.5" detail="Single instance . 89 tables . all data" color="var(--green)" port=":5432" mem="200M" />
                <Svc name="Redis (cache)" detail="Rate limiting . general cache" color="var(--red)" port=":6379" mem="160M" />
                <Svc name="Redis (sessions)" detail="Session storage . no persistence" color="var(--red)" port=":6379" mem="96M" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                <Svc name="Processor" detail="File upload . OCR . image opt . read-only FS" color="var(--violet)" port=":3003" mem="1280M" />
                <Svc name="Migrate" detail="Drizzle migrations . runs once" color="var(--dim)" mem="one-shot" />
                <Svc name="Cron" detail="Alpine crond . HMAC-signed reqs" color="var(--amber)" mem="~32M" />
              </div>
            </Zone>
          </Zone>

          <div style={{
            display: "flex", gap: 8, marginTop: 10, padding: "6px 12px",
            background: "var(--s2)", borderRadius: 8, border: "1px solid var(--border)",
            fontSize: 8, color: "var(--dim)", fontFamily: "var(--mono)", flexWrap: "wrap",
          }}>
            <strong style={{ color: "var(--text)" }}>Volumes:</strong>
            postgres_data . redis_data . redis_sessions . file_storage (web+proc) . cache_storage
          </div>
        </div>

        {/* RIGHT SIDEBAR: current details */}
        <div>
          <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: 1.5, color: "var(--amber)", textTransform: "uppercase" as CSSProperties["textTransform"], marginBottom: 10 }}>
            8 Cron Jobs
          </div>
          <div style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}>
            <CronJob schedule="*/5m" name="Calendar sync" endpoint="/api/cron/calendar-sync" />
            <CronJob schedule="*/5m" name="Workflows" endpoint="/api/cron/workflows" />
            <CronJob schedule="1h" name="Token cleanup" endpoint="/api/cron/cleanup-tokens" />
            <CronJob schedule="6h" name="Pulse" endpoint="/api/pulse/cron" />
            <CronJob schedule="2am" name="Audit verify" endpoint="/api/cron/verify-audit-chain" />
            <CronJob schedule="3am" name="AI log purge" endpoint="/api/cron/purge-ai-usage-logs" />
            <CronJob schedule="4am" name="Msg purge" endpoint="/api/cron/purge-deleted-messages" />
            <CronJob schedule="6am" name="Memory" endpoint="/api/memory/cron" />
          </div>

          <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: 1.5, color: "var(--cyan)", textTransform: "uppercase" as CSSProperties["textTransform"], marginBottom: 10 }}>
            Images (ghcr.io/2witstudios/)
          </div>
          <div style={{
            background: "var(--s1)", border: "1px solid var(--border)", borderRadius: 10,
            padding: "10px 12px", marginBottom: 14,
            fontSize: 8, color: "var(--mid)", fontFamily: "var(--mono)", lineHeight: 1.8,
          }}>
            pagespace-web<br />pagespace-realtime<br />pagespace-processor<br />pagespace-migrate<br />pagespace-cron<br />pagespace-marketing
          </div>

          <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: 1.5, color: "var(--green)", textTransform: "uppercase" as CSSProperties["textTransform"], marginBottom: 10 }}>
            89 tables, 1 Postgres
          </div>
          <div style={{
            background: "var(--s1)", border: "1px solid var(--border)", borderRadius: 10,
            padding: "10px 12px",
            fontSize: 8, color: "var(--mid)", fontFamily: "var(--mono)", lineHeight: 1.7,
          }}>
            <strong style={{ color: "var(--green)" }}>Auth:</strong> users, sessions, passkeys, tokens<br />
            <strong style={{ color: "var(--blue)" }}>Core:</strong> drives, pages, versions, files<br />
            <strong style={{ color: "var(--cyan)" }}>Chat:</strong> conversations, messages, channels<br />
            <strong style={{ color: "var(--violet)" }}>Tasks:</strong> taskLists, taskItems, assignees<br />
            <strong style={{ color: "var(--amber)" }}>Calendar:</strong> events, attendees, google<br />
            <strong style={{ color: "var(--red)" }}>Billing:</strong> subscriptions, stripeEvents<br />
            <strong style={{ color: "var(--dim)" }}>+60 more</strong>
          </div>
        </div>
      </div>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 5: What's missing (gap analysis)               */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Gap Analysis</div>
      <h2>
        What's missing from{" "}
        <span className="hl">PageSpace today.</span>
      </h2>
      <p style={{ marginBottom: 8, maxWidth: 720 }}>
        A capability-by-capability look at where PageSpace stands today versus
        where it needs to be. This is the build list &mdash; not aspirations,
        but concrete gaps between the current platform and the target.
      </p>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        <span style={{ color: "var(--green)", fontWeight: 600 }}>Green</span> = ready today.{" "}
        <span style={{ color: "var(--blue)", fontWeight: 600 }}>Blue</span> = target capability.{" "}
        The status column shows where each capability stands.
      </p>

      <Card style={{ overflow: "auto", marginBottom: 24, padding: 0 }}>
        <DataTable headers={["Capability", "Today", "Target", "Status"]}>
          <SectionHeader text="Agent Execution" color="var(--blue)" />
          <CompareRow
            capability="Agent loop"
            pagespace="Single-turn: user msg -> LLM -> tool calls -> response"
            col2="Full loop: plan -> execute -> evaluate -> loop (MAX_ITER)"
            verdict="Not started"
            verdictColor="var(--red)"
          />
          <CompareRow
            capability="LLM providers"
            pagespace="100+ models via Vercel AI SDK (11 providers)"
            col2="Same, with failover and budget-aware routing"
            verdict="Strong foundation"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="Tools"
            pagespace="33+ tools (page CRUD, search, agent-to-agent)"
            col2="Expanded: file ops, shell, MCP server endpoint"
            verdict="Strong foundation"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="Sandboxing"
            pagespace="None. Tools run in Node.js process"
            col2="Firecracker VMs + capability-gated execution"
            verdict="Not started"
            verdictColor="var(--red)"
          />
          <CompareRow
            capability="Scheduling"
            pagespace="Schema exists, no executor"
            col2="Full cron + triggers (reactive/periodic/proactive/continuous)"
            verdict="Schema only"
            verdictColor="var(--amber)"
          />
          <CompareRow
            capability="Workflows"
            pagespace="Schema exists, no executor"
            col2="Full engine: fan-out/fan-in/loops/conditionals/retry"
            verdict="Schema only"
            verdictColor="var(--amber)"
          />
          <CompareRow
            capability="Agent memory"
            pagespace="Conversation history only"
            col2="Scoped memory: context/task/plan/global + semantic search"
            verdict="Minimal"
            verdictColor="var(--amber)"
          />

          <SectionHeader text="Platform & Governance" color="var(--green)" />
          <CompareRow
            capability="RBAC"
            pagespace="Full: Owner/Admin/Member + page-level permissions, Redis-cached"
            col2="Same, extended with agent scope inheritance"
            verdict="Production ready"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="Multi-tenant"
            pagespace="Full control plane: provision/suspend/resume/upgrade/destroy"
            col2="Same, extended for runtime + container provisioning"
            verdict="Production ready"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="Content management"
            pagespace="10 page types, drives, version history, file processing"
            col2="Same, plus BRANCH page type for containers"
            verdict="Production ready"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="Real-time collab"
            pagespace="Socket.IO, per-event auth, presence tracking"
            col2="Same, streaming agent output to browsers"
            verdict="Production ready"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="Billing"
            pagespace="Stripe: webhooks, checkout, portal, tiers"
            col2="Same, plus per-agent budget metering"
            verdict="Production ready"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="Search"
            pagespace="Page content search + Brave web search (domain/recency filtering)"
            col2="Add semantic search (pgvector) + knowledge graph"
            verdict="Partial"
            verdictColor="var(--amber)"
          />

          <SectionHeader text="Integration & Channels" color="var(--cyan)" />
          <CompareRow
            capability="MCP"
            pagespace="Client integration (provider type)"
            col2="Client + server endpoint, credential vault"
            verdict="Partial"
            verdictColor="var(--amber)"
          />
          <CompareRow
            capability="Channel adapters"
            pagespace="Web UI + Socket.IO"
            col2="Add Slack, Discord, email, and more"
            verdict="Web only"
            verdictColor="var(--amber)"
          />
          <CompareRow
            capability="API"
            pagespace="251 endpoints (Next.js API routes)"
            col2="Same, plus runtime service API + OpenAI-compat endpoint"
            verdict="Strong foundation"
            verdictColor="var(--green)"
          />
        </DataTable>
      </Card>

      <div className="sl">Summary</div>
      <h2>
        Platform is strong.{" "}
        <span className="hl">Runtime is the gap.</span>
      </h2>

      <div className="g2">
        <Card accent="green">
          <h4>What PageSpace has</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Team RBAC, multi-tenant provisioning, content management,
            real-time collaboration, billing, file governance. These are the
            <strong> platform capabilities</strong> that take years to build well.
            They are production-ready today.
          </p>
        </Card>
        <Card accent="blue">
          <h4>What PageSpace needs</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Agent loop, execution containers, workflow engine, scheduling,
            persistent memory, budget metering, channel adapters. These are the
            <strong> runtime capabilities</strong> that turn a collaboration platform
            into an agent platform.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)", marginTop: 12 }}>
        <h4 style={{ color: "var(--blue)" }}>The approach</h4>
        <p style={{ fontSize: 12 }}>
          Build the runtime into PageSpace as a native service. One codebase,
          one auth system, one database, one product. The platform capabilities
          are already in production. The runtime fills the gap.
        </p>
      </Card>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 6: Today vs target                             */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Today vs target</div>
      <h2>
        From collaboration platform to{" "}
        <span className="hl">self-extending OS.</span>
      </h2>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="amber">
          <h4 style={{ color: "var(--amber)" }}>Today: most of an OS</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Filesystem (pages), permissions (RBAC), networking (Socket.IO),
            storage (Postgres), user space (drives). Multi-tool agents with
            delegation, task management, and workflow scheduling. But execution
            is request-bound &mdash; no autonomous loops, no containers, no
            shell access.
          </p>
        </Card>
        <Card accent="cyan">
          <h4 style={{ color: "var(--cyan)" }}>Target: a complete OS</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Add CLI agents (processes) and containers (execution). Now
            the OS runs programs on its own data. Agents build apps,
            deploy sites, automate workflows &mdash; all inside
            PageSpace. The OS starts extending itself.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)" }}>
        <h4 style={{ color: "var(--blue)" }}>Why both gaps matter together</h4>
        <p style={{ fontSize: 12 }}>
          A runtime without code execution is just a chatbot. Code execution
          without a runtime is just a hosted IDE. Together they create
          something new: a platform where your data, your agents, and your
          apps all live in the same place. A repo inside PageSpace is a
          drive (for the team) and a deployable app (built by agents) at the
          same time. The platform starts building its own interfaces,
          its own tools, its own workflows &mdash; from the inside.
        </p>
      </Card>
    </div>
  );
}
