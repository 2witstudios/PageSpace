import type { CSSProperties } from "react";
import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import { DataTable, CompareRow, SectionHeader } from "../ui/DataTable";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";

/* ── InfraPane helpers (inlined to keep this file self-contained) ── */

function Svc({ name, detail, color, port, mem }: {
  name: string; detail: string; color?: string; port?: string; mem?: string;
}) {
  return (
    <div style={{
      background: "var(--s2)", border: `1px solid ${color ? `${color}40` : "var(--border)"}`,
      borderRadius: 8, padding: "8px 12px", flex: 1, minWidth: 80,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: color ?? "var(--text)" }}>{name}</div>
        {port && <span style={{ fontSize: 8, color: "var(--dim)", fontFamily: "var(--mono)" }}>{port}</span>}
      </div>
      <div style={{ fontSize: 8, color: "var(--dim)", fontFamily: "var(--mono)", lineHeight: 1.5 }}>{detail}</div>
      {mem && <div style={{ fontSize: 7, color: "var(--dim)", fontFamily: "var(--mono)", marginTop: 2 }}>mem: {mem}</div>}
    </div>
  );
}

function Zone({ label, color, children, style, badge }: {
  label: string; color: string; children: React.ReactNode;
  style?: CSSProperties; badge?: string;
}) {
  return (
    <div style={{
      border: `1px solid ${color}30`, borderRadius: 12,
      background: `${color}06`, padding: "32px 14px 14px",
      position: "relative", ...style,
    }}>
      <div style={{
        position: "absolute", top: 8, left: 12,
        fontSize: 9, fontWeight: 600, letterSpacing: 1.2,
        textTransform: "uppercase" as CSSProperties["textTransform"],
        color, display: "flex", gap: 6, alignItems: "center",
      }}>
        {label}
        {badge && (
          <span style={{
            fontSize: 7, padding: "1px 5px", borderRadius: 10,
            background: `${color}15`, border: `1px solid ${color}30`,
            letterSpacing: 0, textTransform: "none" as CSSProperties["textTransform"],
            fontWeight: 500,
          }}>{badge}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function Flow({ label, color }: { label: string; color?: string }) {
  return (
    <div style={{
      textAlign: "center", padding: "3px 0", fontSize: 8,
      color: color ?? "var(--dim)", fontFamily: "var(--mono)",
      display: "flex", alignItems: "center", gap: 6, justifyContent: "center",
    }}>
      <span style={{ flex: 1, maxWidth: 40, height: 1, background: color ?? "var(--border)" }} />
      <span>&#x25BC; {label}</span>
      <span style={{ flex: 1, maxWidth: 40, height: 1, background: color ?? "var(--border)" }} />
    </div>
  );
}

function Callout({ title, color, children }: {
  title: string; color: string; children: React.ReactNode;
}) {
  return (
    <div style={{
      borderLeft: `3px solid ${color}`,
      background: "var(--s1)", borderRadius: "0 10px 10px 0",
      padding: "14px 16px", marginBottom: 12,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 11, color: "var(--mid)", lineHeight: 1.7 }}>{children}</div>
    </div>
  );
}

function CronJob({ schedule, name, endpoint }: { schedule: string; name: string; endpoint: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 9, fontFamily: "var(--mono)", color: "var(--dim)", lineHeight: 1.8 }}>
      <span style={{ color: "var(--amber)", minWidth: 65 }}>{schedule}</span>
      <span style={{ color: "var(--text)", minWidth: 100 }}>{name}</span>
      <span>{endpoint}</span>
    </div>
  );
}

export function DatabasePane() {
  return (
    <div className="pane-wide">
      <div className="sl">Database + Infrastructure</div>
      <h2>
        From single Postgres to{" "}
        <span className="hl">tiered org isolation on AWS.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        Current state, competitive landscape, and the end-game architecture.
        The migration path from a single VPS to per-org database isolation
        with a global control plane on AWS.
      </p>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 1: CURRENT                                     */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Current</div>
      <h3 style={{ marginBottom: 16 }}>
        Single VPS. Single Postgres. 75 tables. 8 running containers.{" "}
        <span style={{ color: "var(--dim)", fontWeight: 400 }}>No agent runtime, no container execution, no org isolation.</span>
      </h3>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20, alignItems: "start", marginBottom: 28 }}>
        <div style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: 14, padding: 16 }}>

          <Zone label="Caddy" color="var(--green)" badge="reverse proxy - :443">
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
                <Svc name="Web (Next.js)" detail="API routes - AI chat - 33+ tools" color="var(--cyan)" port=":3000" mem="768M" />
                <Svc name="Realtime" detail="Socket.IO - presence - per-event auth" color="var(--cyan)" port=":3001" mem="256M" />
                <Svc name="Marketing" detail="Landing pages - docs - pricing" color="var(--cyan)" port=":3004" mem="256M" />
              </div>
            </Zone>
            <Zone label="Internal Network" color="var(--violet)" badge="no external access">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 6 }}>
                <Svc name="PostgreSQL 17.5" detail="Single instance - 75 tables - all data" color="var(--green)" port=":5432" mem="200M" />
                <Svc name="Redis (cache)" detail="Rate limiting - general cache" color="var(--red)" port=":6379" mem="160M" />
                <Svc name="Redis (sessions)" detail="Session storage - no persistence" color="var(--red)" port=":6379" mem="96M" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                <Svc name="Processor" detail="File upload - OCR - image opt - read-only FS" color="var(--violet)" port=":3003" mem="1280M" />
                <Svc name="Migrate" detail="Drizzle migrations - runs once" color="var(--dim)" mem="one-shot" />
                <Svc name="Cron" detail="Alpine crond - HMAC-signed reqs" color="var(--amber)" mem="~32M" />
              </div>
            </Zone>
          </Zone>

          <div style={{
            display: "flex", gap: 8, marginTop: 10, padding: "6px 12px",
            background: "var(--s2)", borderRadius: 8, border: "1px solid var(--border)",
            fontSize: 8, color: "var(--dim)", fontFamily: "var(--mono)", flexWrap: "wrap",
          }}>
            <strong style={{ color: "var(--text)" }}>Volumes:</strong>
            postgres_data - redis_data - redis_sessions - file_storage (web+proc) - cache_storage
          </div>
        </div>

        {/* RIGHT SIDEBAR: current details */}
        <div>
          <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: 1.5, color: "var(--amber)", textTransform: "uppercase" as CSSProperties["textTransform"], marginBottom: 10 }}>
            10 Cron Jobs
          </div>
          <div style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}>
            <CronJob schedule="*/5 min" name="Calendar sync" endpoint="/api/cron/calendar-sync" />
            <CronJob schedule="*/5 min" name="Workflows" endpoint="/api/cron/workflows" />
            <CronJob schedule="hourly" name="Token cleanup" endpoint="/api/cron/cleanup-tokens" />
            <CronJob schedule="*/6h" name="Pulse" endpoint="/api/pulse/cron" />
            <CronJob schedule="1am" name="Retention cleanup" endpoint="/api/cron/retention-cleanup" />
            <CronJob schedule="2am" name="Audit verify" endpoint="/api/cron/verify-audit-chain" />
            <CronJob schedule="3am" name="AI log purge" endpoint="/api/cron/purge-ai-usage-logs" />
            <CronJob schedule="4am" name="Msg purge" endpoint="/api/cron/purge-deleted-messages" />
            <CronJob schedule="6am" name="Memory" endpoint="/api/memory/cron" />
            <CronJob schedule="Sun 5am" name="Orphan cleanup" endpoint="/api/cron/cleanup-orphaned-files" />
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
            75 tables, 1 Postgres
          </div>
          <div style={{
            background: "var(--s1)", border: "1px solid var(--border)", borderRadius: 10,
            padding: "10px 12px",
            fontSize: 8, color: "var(--mid)", fontFamily: "var(--mono)", lineHeight: 1.7,
          }}>
            <strong style={{ color: "var(--green)" }}>Auth (9):</strong> users, sessions, passkeys, tokens<br />
            <strong style={{ color: "var(--blue)" }}>Core (9):</strong> drives, pages, tags, favorites<br />
            <strong style={{ color: "var(--cyan)" }}>Chat (3):</strong> channels, reactions, read status<br />
            <strong style={{ color: "var(--violet)" }}>Tasks (4):</strong> taskLists, taskItems, assignees<br />
            <strong style={{ color: "var(--amber)" }}>Calendar (3):</strong> events, attendees, google<br />
            <strong style={{ color: "var(--red)" }}>Billing (2):</strong> subscriptions, stripeEvents<br />
            <strong style={{ color: "var(--dim)" }}>+45 more</strong> across 28 schema files
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 2: GAPS                                        */}
      {/* ═══════════════════════════════════════════════════════ */}

      <hr />

      <div className="sl">Gaps</div>
      <h2>
        What&apos;s missing{" "}
        <span className="hl">from today&apos;s setup.</span>
      </h2>

      <div className="g3" style={{ marginBottom: 24 }}>
        <Card accent="red">
          <h4 style={{ color: "var(--red)" }}>No database isolation</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            All 75 tables live in a single PostgreSQL instance. Every tenant,
            every drive, every user shares the same database. No per-org
            separation, no tiered isolation.
          </p>
        </Card>
        <Card accent="red">
          <h4 style={{ color: "var(--red)" }}>Single VPS capacity</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            One VPS running Docker Compose can support ~18-20 tenants max.
            No horizontal scaling, no auto-provisioning beyond that ceiling.
            Vertical scaling is the only option.
          </p>
        </Card>
        <Card accent="red">
          <h4 style={{ color: "var(--red)" }}>No container hierarchy</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            No Firecracker VMs, no per-branch containers, no org-level
            containment beyond Docker Compose. The container hierarchy
            (Org &gt; Drive &gt; Repo &gt; Branch &gt; Page &gt; Agent)
            does not exist yet.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)", marginBottom: 28 }}>
        <h4 style={{ color: "var(--dim)" }}>What IS already built toward this</h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          Control plane with <code>createProvisioningEngine(deps)</code> using
          dependency injection &mdash; the provisioner is backend-agnostic by
          design. Tenant lifecycle management (<code>createTenantLifecycle</code>)
          supports suspend, resume, upgrade, and destroy with automatic
          pg_dump backup before teardown. Data migration tooling exists:
          export (<code>tenant-export.ts</code>), import (<code>tenant-import.ts</code>),
          and validation (<code>tenant-validate.ts</code>) scripts with tests.
          CUID2 IDs ensure no collisions across databases.
        </p>
      </Card>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 3: COMPETITIVE LANDSCAPE                       */}
      {/* ═══════════════════════════════════════════════════════ */}

      <hr />

      <div className="sl">Competitive Landscape</div>
      <h2>
        Agent frameworks vs.{" "}
        <span className="hl">a complete platform.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The emerging agent ecosystem builds personal runtimes &mdash; single-user,
        local databases, no shared state. PageSpace builds the team platform
        those agents need to operate: cloud Postgres, real-time collaboration,
        shared data that multiple humans and agents access simultaneously.
      </p>

      <Card style={{ overflow: "auto", marginBottom: 16, padding: 0 }}>
        <DataTable headers={["", "PageSpace", "OpenFang", "OpenClaw"]}>
          <CompareRow
            capability="Architecture"
            pagespace="Full SaaS platform &mdash; Next.js + Postgres + Redis + Socket.IO"
            col2="Single Rust binary &mdash; 137K lines, compiles to one executable"
            verdict="Local-first agent &mdash; runs on user machine or private server"
            verdictColor="var(--mid)"
          />
          <CompareRow
            capability="Data layer"
            pagespace="Cloud Postgres &mdash; 75 tables, team-shared, multi-user concurrent access"
            col2="SQLite &mdash; embedded in binary, single-user, personal only"
            verdict="Local files &mdash; one user&apos;s interaction history on disk"
            verdictColor="var(--mid)"
          />
          <CompareRow
            capability="Multi-tenancy"
            pagespace="Cloud-native &mdash; control plane, tenant provisioning, team shared state"
            col2="None &mdash; one agent, one user, one machine"
            verdict="None &mdash; one bot per install, no team access"
            verdictColor="var(--mid)"
          />
          <CompareRow
            capability="Real-time"
            pagespace="Socket.IO &mdash; presence, cursors, per-event auth, streaming"
            col2="40 channel adapters &mdash; Slack, Discord, email, etc."
            verdict="Channel adapter layer &mdash; messaging platform integration"
            verdictColor="var(--mid)"
          />
          <CompareRow
            capability="Memory"
            pagespace="Team-shared &mdash; conversations, versions, audit logs visible to whole org"
            col2="Personal &mdash; episodic + semantic + procedural, one user only"
            verdict="Personal &mdash; local sessions, no team visibility"
            verdictColor="var(--mid)"
          />
          <CompareRow
            capability="Security"
            pagespace="RBAC, opaque sessions, HMAC cron, audit chain, rate limiting"
            col2="16-layer &mdash; WASM sandbox, Merkle audit, prompt injection scanner"
            verdict="SSL in transit, encrypted at rest, no external calls by default"
            verdictColor="var(--mid)"
          />
          <CompareRow
            capability="Scale model"
            pagespace="Cloud teams &rarr; per-org isolation &rarr; enterprise dedicated infra"
            col2="Personal binary &rarr; peer-to-peer agent networking"
            verdict="Personal install &rarr; 250K+ stars &rarr; community plugins"
            verdictColor="var(--mid)"
          />
        </DataTable>
      </Card>

      <div className="g3" style={{ marginBottom: 24 }}>
        <Card accent="cyan">
          <h4 style={{ color: "var(--cyan)" }}>OpenFang</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Rust agent OS. 180ms cold start, 40MB RAM. SQLite memory,
            WASM sandbox, MCP client/server. <strong>Local-first by design</strong> &mdash;
            one agent, one user, one machine. Optimized for personal,
            local-first agent workflows with minimal overhead.
          </p>
        </Card>
        <Card accent="violet">
          <h4 style={{ color: "var(--violet)" }}>OpenClaw</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Fastest-growing GitHub project in history (250K+ stars in 60 days).
            Four-layer architecture: channel adapter, agent core, skill plugins,
            memory. <strong>Runs on one person&apos;s machine</strong> &mdash; config and
            history stored locally. No cloud database, no team collaboration,
            no shared workspace.
          </p>
        </Card>
        <Card accent="amber">
          <h4 style={{ color: "var(--amber)" }}>Viktor AI</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Low-code engineering platform (Python SDK). Enterprise SSO,
            multi-regional cloud. Focused on AEC industry &mdash; structural
            engineering, automation workflows. Not a general-purpose SaaS
            platform. Different market entirely.
          </p>
        </Card>
      </div>

      <Card accent="green" style={{ marginBottom: 12 }}>
        <h4 style={{ color: "var(--green)" }}>PageSpace differentiator: cloud, team-accessible data</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          OpenFang and OpenClaw optimize for personal agents with local databases
          &mdash; fast, private, zero-latency. PageSpace optimizes for
          <strong>team agents with a shared cloud database</strong> &mdash;
          75 tables of shared state that humans and agents access concurrently.
          When an agent writes a page, the whole team sees it in real-time. When a
          teammate updates a task, the agent reacts. These are different data models
          for different use cases: local speed vs. team coordination.
        </p>
      </Card>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 4: END GAME                                    */}
      {/* ═══════════════════════════════════════════════════════ */}

      <hr />

      <div className="sl">End Game</div>
      <h2>
        Per-org isolation.{" "}
        <span className="hl">AWS. Firecracker. Tiered databases.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The end-game splits 75 tables into ~33 global + ~36 per-org + ~6
        dual-scoped, with tiered isolation by plan. The container hierarchy
        nests Org &gt; Drive &gt; Repo &gt; Branch &gt; Page &gt; Agent.
        Every interface &mdash; IDE, CMS, CRM &mdash; is a lens on the same
        OS, backed by the same data.
      </p>

      {/* End-game infra diagram */}
      <h3 style={{ marginBottom: 16 }}>
        AWS. Per-org isolation. Agent runtime. Firecracker VMs.{" "}
        <span style={{ color: "var(--blue)", fontWeight: 400 }}>The universal agent substrate.</span>
      </h3>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20, alignItems: "start", marginBottom: 28 }}>
        <div style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: 14, padding: 16 }}>

          {/* GLOBAL */}
          <Zone label="Global" color="var(--green)" badge="shared across all orgs">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
              <Svc name="Global Postgres (RDS)" detail="~33 tables: users, auth, billing, DMs, monitoring" color="var(--green)" />
              <Svc name="Auth" detail="Opaque tokens - passkeys - OAuth - sessions" color="var(--red)" />
              <Svc name="Billing" detail="Stripe - subscriptions - tiers" color="var(--amber)" />
              <Svc name="Control Plane" detail="Provisioner - lifecycle - health" color="var(--amber)" />
            </div>

            <Flow label="provisions + auth" color="var(--green)" />

            <div style={{ display: "grid", gridTemplateColumns: "2fr 5fr", gap: 10 }}>

              {/* SHARED ORG */}
              <Zone label="Shared" color="var(--dim)" badge="free" style={{ opacity: 0.8 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <Svc name="Shared Postgres" detail="Row isolation by orgId" />
                  <Svc name="Web + Realtime" detail="Shared ECS tasks" />
                  <Svc name="Redis" detail="Shared cache" />
                </div>
                <div style={{
                  marginTop: 8, padding: "4px 8px", borderRadius: 6,
                  background: "var(--s3)", fontSize: 8, color: "var(--dim)",
                  fontFamily: "var(--mono)", textAlign: "center",
                }}>
                  No containers or runtime<br />
                  Upgrade for dedicated infra
                </div>
              </Zone>

              {/* TEAM ORG */}
              <Zone label="Team Org" color="var(--blue)" badge="paid - dedicated">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5, marginBottom: 8 }}>
                  <Svc name="Org Postgres (RDS)" detail="~36 tables - dedicated - content, collab, tasks" color="var(--blue)" />
                  <Svc name="Redis" detail="ElastiCache - dedicated" color="var(--cyan)" />
                  <Svc name="S3" detail="File storage" color="var(--amber)" />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 5, marginBottom: 8 }}>
                  <Svc name="Web" detail="Dedicated ECS" color="var(--cyan)" />
                  <Svc name="Realtime" detail="Socket.IO" color="var(--cyan)" />
                  <Svc name="Processor" detail="Files - OCR" color="var(--cyan)" />
                  <Svc name="Runtime" detail="Agent loops - scheduling - workflows" color="var(--blue)" />
                </div>

                <Flow label="spawns VMs" color="var(--violet)" />

                <Zone label="Execution" color="var(--violet)" badge="Firecracker VMs">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <Zone label="main" color="var(--violet)" style={{ padding: "22px 10px 10px" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <Svc name="VM" detail="Isolated - shell - git" color="var(--violet)" />
                        <Svc name="Turso" detail="Synced from Org PG" />
                        <div style={{ display: "flex", gap: 3 }}>
                          <Svc name="Agent" detail="impl" color="var(--violet)" />
                          <Svc name="Agent" detail="review" color="var(--violet)" />
                        </div>
                      </div>
                    </Zone>
                    <Zone label="feature/billing" color="var(--violet)" style={{ padding: "22px 10px 10px" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <Svc name="VM" detail="Parallel - isolated" color="var(--violet)" />
                        <Svc name="Turso" detail="Independent state" />
                        <Svc name="Agent" detail="coding" color="var(--violet)" />
                      </div>
                    </Zone>
                  </div>
                </Zone>
              </Zone>
            </div>
          </Zone>

          <div style={{
            display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap",
            marginTop: 12, padding: "8px 16px",
            background: "var(--s2)", borderRadius: 8, border: "1px solid var(--border)",
            fontSize: 9, color: "var(--mid)", fontFamily: "var(--mono)",
          }}>
            <span><strong style={{ color: "var(--green)" }}>Global:</strong> 1x RDS - ~33 tables</span>
            <span style={{ color: "var(--border)" }}>|</span>
            <span><strong style={{ color: "var(--blue)" }}>Per org:</strong> 1x RDS - 1x Redis - 1x S3 - 4x ECS - Nx VMs</span>
            <span style={{ color: "var(--border)" }}>|</span>
            <span><strong style={{ color: "var(--dim)" }}>Free:</strong> shared - row isolation</span>
          </div>
        </div>

        {/* RIGHT: WHY THIS IS THE PERFECT AGENT ENVIRONMENT */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 2, color: "var(--blue)",
            textTransform: "uppercase" as CSSProperties["textTransform"],
            marginBottom: 14,
          }}>
            Why this is the perfect agent environment
          </div>

          <Callout title="Agents build apps from the same data" color="var(--blue)">
            Firecracker VMs access the org&apos;s Postgres via Turso sync.
            Agents create apps backed by the same data the team uses.
            The repo IS a PageSpace drive.
          </Callout>

          <Callout title="Domains + networking = deployable repos" color="var(--cyan)">
            Add domain routing and every repo inside PageSpace becomes a
            deployable site. Ship from where you build.
          </Callout>

          <Callout title="What personal databases can't do" color="var(--violet)">
            OpenFang and OpenClaw give agents a personal SQLite. PageSpace
            gives agents a team Postgres &mdash; shared state, real-time sync,
            RBAC, audit logs. Agent work is visible to the whole org
            the moment it happens. That&apos;s the difference between
            a personal tool and a team OS.
          </Callout>

          <Callout title="Always-on, not just chat" color="var(--green)">
            Runtime runs 24/7. Agents schedule themselves, react to
            triggers, run workflows autonomously within permission boundaries.
          </Callout>

          <Callout title="Team governance at every layer" color="var(--amber)">
            AI billing, API keys, integration credentials per-org.
            Per-agent budgets. Capability gates. Teams control what
            agents can do, spend, and access.
          </Callout>

          <Callout title="Containers are pages, not ops" color="var(--red)">
            Create a BRANCH page, get a VM. Delete the page, destroy it.
            No DevOps. The page tree IS the infrastructure.
          </Callout>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SCHEMA SPLIT                                           */}
      {/* ═══════════════════════════════════════════════════════ */}

      <hr />

      <div className="sl">Schema Split</div>
      <h2>
        75 tables across two databases.{" "}
        <span className="hl">What goes where.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The current schema has 75 <code>pgTable()</code> definitions across
        28 schema files. Splitting into Global + Org databases means deciding
        which tables live where. The rule: <strong>user identity and billing
        are global, content and collaboration are per-org.</strong>
      </p>

      <Card style={{ overflow: "auto", marginBottom: 24, padding: 0 }}>
        <DataTable headers={["Tables", "Database", "Count", "Notes"]}>
          <SectionHeader text="Global Postgres (~33 tables)" color="var(--green)" />
          <CompareRow
            capability="Auth & tokens"
            pagespace="users, sessions, passkeys, deviceTokens, mcpTokens, mcpTokenDrives, verificationTokens, socketTokens, emailUnsubscribeTokens"
            col2="Global"
            verdict="9 tables"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="Billing"
            pagespace="subscriptions, stripeEvents"
            col2="Global"
            verdict="2 tables"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="User preferences"
            pagespace="userPersonalization, displayPreferences, userHotkeyPreferences, userAiSettings, userDashboards, pulseSummaries"
            col2="Global"
            verdict="6 tables"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="Notifications"
            pagespace="notifications, emailNotificationPreferences, emailNotificationLog, pushNotificationTokens"
            col2="Global"
            verdict="4 tables"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="Social / DMs"
            pagespace="connections, dmConversations, directMessages"
            col2="Global"
            verdict="3 tables"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="Monitoring"
            pagespace="securityAuditLog, systemLogs, apiMetrics, userActivities, aiUsageLogs, errorLogs, activityLogs"
            col2="Global"
            verdict="7 tables"
            verdictColor="var(--green)"
          />
          <CompareRow
            capability="Other"
            pagespace="contactSubmissions, feedbackSubmissions"
            col2="Global"
            verdict="2 tables"
            verdictColor="var(--green)"
          />

          <SectionHeader text="Org Postgres (~36 tables - per team or shared)" color="var(--blue)" />
          <CompareRow
            capability="Core content"
            pagespace="drives, pages, chatMessages, tags, pageTags, storageEvents, favorites, mentions, userMentions"
            col2="Per-org"
            verdict="9 tables"
            verdictColor="var(--blue)"
          />
          <CompareRow
            capability="Members"
            pagespace="userProfiles, driveRoles, driveMembers, pagePermissions"
            col2="Per-org"
            verdict="4 tables"
            verdictColor="var(--blue)"
          />
          <CompareRow
            capability="Permissions"
            pagespace="permissions"
            col2="Per-org"
            verdict="1 table"
            verdictColor="var(--blue)"
          />
          <CompareRow
            capability="Conversations"
            pagespace="conversations, messages"
            col2="Per-org"
            verdict="2 tables"
            verdictColor="var(--blue)"
          />
          <CompareRow
            capability="Channels"
            pagespace="channelMessages, channelMessageReactions, channelReadStatus"
            col2="Per-org"
            verdict="3 tables"
            verdictColor="var(--blue)"
          />
          <CompareRow
            capability="Storage"
            pagespace="files, filePages"
            col2="Per-org"
            verdict="2 tables"
            verdictColor="var(--blue)"
          />
          <CompareRow
            capability="Versioning"
            pagespace="pageVersions, driveBackups, driveBackupPages, driveBackupPermissions, driveBackupMembers, driveBackupRoles, driveBackupFiles"
            col2="Per-org"
            verdict="7 tables"
            verdictColor="var(--blue)"
          />
          <CompareRow
            capability="Tasks"
            pagespace="taskLists, taskStatusConfigs, taskItems, taskAssignees"
            col2="Per-org"
            verdict="4 tables"
            verdictColor="var(--blue)"
          />
          <CompareRow
            capability="Other"
            pagespace="workflows, calendarEvents, eventAttendees, userPageViews"
            col2="Per-org"
            verdict="4 tables"
            verdictColor="var(--blue)"
          />

          <SectionHeader text="Edge cases (need design decision) — 6 tables" color="var(--amber)" />
          <CompareRow
            capability="integrationProviders"
            pagespace="Can be system-wide (MCP) or drive-specific (custom)"
            col2="Both?"
            verdict="Dual-scoped"
            verdictColor="var(--amber)"
          />
          <CompareRow
            capability="integrationConnections"
            pagespace="User-scoped OAuth OR drive-scoped API keys"
            col2="Both?"
            verdict="Dual-scoped"
            verdictColor="var(--amber)"
          />
          <CompareRow
            capability="integrationToolGrants"
            pagespace="Per-drive tool permissions for integrations"
            col2="Per-org?"
            verdict="Likely per-org"
            verdictColor="var(--amber)"
          />
          <CompareRow
            capability="integrationAuditLog"
            pagespace="Audit trail for integration actions"
            col2="Per-org?"
            verdict="Likely per-org"
            verdictColor="var(--amber)"
          />
          <CompareRow
            capability="googleCalendarConnections"
            pagespace="User-scoped tokens but syncs to specific drives"
            col2="Global?"
            verdict="Cross-boundary"
            verdictColor="var(--amber)"
          />
          <CompareRow
            capability="globalAssistantConfig"
            pagespace="User's global assistant integration prefs"
            col2="Global?"
            verdict="Cross-boundary"
            verdictColor="var(--amber)"
          />
        </DataTable>
      </Card>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* TIERED ISOLATION                                       */}
      {/* ═══════════════════════════════════════════════════════ */}

      <hr />

      <div className="sl">Database Isolation</div>
      <h2>
        Tiered by plan.{" "}
        <span className="hl">Global + shared + dedicated.</span>
      </h2>

      <Card style={{ marginBottom: 24, padding: "20px 24px" }}>
        <pre>
          <span className="t">Global Postgres</span>
          {" (user identity - billing - cross-org aggregation)\n"}
          {"|\n"}
          {"+-- User dashboard (aggregates ALL orgs, like GitHub)\n"}
          {"+-- User auth, sessions, tokens, DMs\n"}
          {"+-- Subscriptions, Stripe events\n"}
          {"+-- Monitoring, security audit\n"}
          {"|\n"}
          {"+-- "}
          <span className="s">Shared Org Postgres</span>
          {" (free/individual users)\n"}
          {"|   |\n"}
          {"|   +-- Org A (row-level isolation)\n"}
          {"|   |   +-- Drive 1, Drive 2 ...\n"}
          {"|   +-- Org B (row-level isolation)\n"}
          {"|       +-- Drive 1 ...\n"}
          {"|\n"}
          {"+-- "}
          <span className="k">Team Org Postgres</span>
          {" (paid team - dedicated DB)\n"}
          {"|   |\n"}
          {"|   +-- AI billing, API keys, integration governance\n"}
          {"|   +-- Drive 1, Drive 2, Drive 3 ...\n"}
          {"|   +-- All content, conversations, tasks, calendar\n"}
          {"|\n"}
          {"+-- "}
          <span className="v">Enterprise Org Postgres</span>
          {" (dedicated DB + dedicated hardware)\n"}
          {"    |\n"}
          {"    +-- Complete infra isolation"}
        </pre>
      </Card>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Free / Individual</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Shared Org Postgres. All free orgs in one database with
            row-level isolation. Cheap to operate. Same schema,
            same features, just shared infrastructure.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Paid Team</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Dedicated Org Postgres. Full database isolation.
            Team governance: AI billing, API keys, integration credentials
            managed at the org level above individual drives.
          </p>
        </Card>
        <Card accent="violet">
          <h4>Enterprise</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Dedicated database AND dedicated hardware. Complete infrastructure
            isolation. Custom retention policies, compliance requirements,
            data residency guarantees.
          </p>
        </Card>
      </div>

      <Card accent="amber" style={{ marginBottom: 12 }}>
        <h4 style={{ color: "var(--amber)" }}>Like GitHub</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          Your user dashboard aggregates activity across ALL your orgs.
          Each org has its own billing, API keys, and integration governance.
          Drives live within orgs. You don&apos;t switch contexts &mdash; you see
          everything. Org is the governance and DB isolation boundary.
        </p>
      </Card>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* AWS MIGRATION                                          */}
      {/* ═══════════════════════════════════════════════════════ */}

      <hr />

      <div className="sl">AWS Infrastructure</div>
      <h2>
        From Docker Compose to{" "}
        <span className="hl">ECS + RDS + ElastiCache.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The control plane uses dependency injection &mdash;
        <code> createProvisioningEngine(deps)</code> accepts a{" "}
        <code>ShellExecutor</code> and <code>TenantRepo</code>. Today it
        runs <code>docker compose up</code>. Tomorrow the same interface
        provisions ECS tasks and RDS instances. No interface changes needed
        &mdash; just a new executor implementation.
      </p>

      <ArchDiagram>
        <ArchRow label="Control" labelSub="plane" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Provisioning Engine"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="live" />}
            detail="provision() &rarr; generate env &rarr; compose up &rarr; poll health &rarr; seed admin<br>Tenant lifecycle: suspend, resume, upgrade, destroy<br>Dependency injection: ShellExecutor + TenantRepo<br>Automatic pg_dump backup before destroy"
          />
        </ArchRow>

        <ArchConnector text="same deps pattern, different executor" />

        <ArchRow label="Current" labelSub="VPS" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Docker Compose Backend"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            status={<StatusBadge variant="live" />}
            detail="docker compose -p ps-{slug} up -d<br>10 services per tenant (8 running + 2 one-shot)<br>generate-tenant-env.sh creates per-tenant .env<br>Capacity: ~18-20 tenants per VPS"
          />
        </ArchRow>

        <ArchConnector text="swap executor when VPS capacity exhausted" />

        <ArchRow label="Target" labelSub="AWS">
          <ArchNode
            title="ECS Fargate"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Container orchestration<br>Same Docker images (ghcr.io/2witstudios/)<br>No EC2 management<br>Per-tenant task definitions"
          />
          <ArchNode
            title="RDS PostgreSQL"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Global RDS (~33 tables: auth, billing)<br>Shared RDS (free: row isolation)<br>Dedicated RDS (paid: ~36 tables)<br>Managed backups + replicas"
          />
          <ArchNode
            title="ElastiCache + S3"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="ElastiCache: Redis per tenant<br>S3: file storage (replaces volumes)<br>ALB: wildcard cert routing<br>Secrets Manager: replaces .env files"
          />
        </ArchRow>
      </ArchDiagram>

      {/* Container hierarchy */}
      <Card style={{ marginBottom: 12 }}>
        <h4 style={{ color: "var(--cyan)" }}>Container Hierarchy</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          <strong>Org</strong> &gt; <strong>Drive</strong> &gt; <strong>Repo</strong> &gt;{" "}
          <strong>Branch</strong> &gt; <strong>Page</strong> &gt; <strong>Agent</strong>.
          Each level provides increasing isolation. Docker is the stepping stone;
          Firecracker is the target (&lt;125ms boot). Branch pages spawn VMs.
          Deleting the page destroys the container. The page tree IS the infrastructure.
        </p>
      </Card>
    </div>
  );
}
