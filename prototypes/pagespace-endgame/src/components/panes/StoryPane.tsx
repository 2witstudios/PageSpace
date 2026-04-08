import type { CSSProperties } from "react";
import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";
import { Zone, Svc, Flow, MigrationArrow } from "../ui/InfraHelpers";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";

const cellTd: CSSProperties = {
  padding: "8px 14px",
  borderBottom: "1px solid rgba(42,42,61,0.5)",
  verticalAlign: "top",
  fontSize: 12,
};

export function StoryPane() {
  return (
    <div className="pane-wide">
      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 1: Where We Are                                */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Today</div>
      <h2>
        Most of an OS.{" "}
        <span className="hl">Already in production.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        PageSpace is a cloud operating system where the page tree is the
        filesystem, agents are processes, and everything an OS provides is
        already built in. Five of seven OS primitives are live. Two are coming.
      </p>

      <Card style={{ overflow: "auto", marginBottom: 16, padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                OS concept
              </th>
              <th style={{ textAlign: "left", fontSize: 10, fontWeight: 600, color: "var(--dim)", letterSpacing: 1.2, textTransform: "uppercase", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
                PageSpace equivalent
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Filesystem</td>
              <td style={{ ...cellTd, color: "var(--green)" }}>Pages &mdash; 9 types, tree hierarchy, drives as volumes</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Permissions</td>
              <td style={{ ...cellTd, color: "var(--green)" }}>RBAC &mdash; Owner / Admin / Member + page-level access</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Processes</td>
              <td style={{ ...cellTd, color: "var(--green)" }}>Agents &mdash; 33+ tools, agent-to-agent delegation</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Networking</td>
              <td style={{ ...cellTd, color: "var(--green)" }}>Real-time &mdash; Socket.IO, presence, per-event auth</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Storage</td>
              <td style={{ ...cellTd, color: "var(--green)" }}>Postgres &mdash; 89 tables, Drizzle ORM, file pipeline</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Shell</td>
              <td style={{ ...cellTd, color: "var(--amber)", fontStyle: "italic" }}>CLI agent runtime &mdash; coming</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)", borderBottom: "none" }}>Programs</td>
              <td style={{ ...cellTd, color: "var(--amber)", fontStyle: "italic", borderBottom: "none" }}>Containers &mdash; coming</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <Card style={{ textAlign: "center", padding: "14px 20px", marginBottom: 24 }}>
        <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--mid)", letterSpacing: 1 }}>
          89 tables &nbsp;&middot;&nbsp; 251 API endpoints &nbsp;&middot;&nbsp; 33+ AI tools &nbsp;&middot;&nbsp; 10 page types &nbsp;&middot;&nbsp; 8 containers &nbsp;&middot;&nbsp; 11 AI providers
        </span>
      </Card>

      {/* Today architecture */}
      <div style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: 14, padding: 16 }}>
        <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: 1.5, color: "var(--amber)", textTransform: "uppercase" as CSSProperties["textTransform"], marginBottom: 10 }}>
          Current &mdash; Single VPS, 8 containers
        </div>

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
              <Svc name="Web (Next.js)" detail="API routes . AI chat . 33+ tools" color="var(--cyan)" port=":3000" mem="768M" />
              <Svc name="Realtime" detail="Socket.IO . presence . per-event auth" color="var(--cyan)" port=":3001" mem="256M" />
              <Svc name="Marketing" detail="Landing pages . docs . pricing" color="var(--cyan)" port=":3004" mem="256M" />
            </div>
          </Zone>
          <Zone label="Internal Network" color="var(--violet)" badge="no external access">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 6 }}>
              <Svc name="PostgreSQL 17.5" detail="Single instance . 89 tables" color="var(--green)" port=":5432" mem="200M" />
              <Svc name="Redis (cache)" detail="Rate limiting . general cache" color="var(--red)" port=":6379" mem="160M" />
              <Svc name="Redis (sessions)" detail="Session storage . no persistence" color="var(--red)" port=":6379" mem="96M" />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              <Svc name="Processor" detail="File upload . OCR . image opt" color="var(--violet)" port=":3003" mem="1280M" />
              <Svc name="Migrate" detail="Drizzle migrations . runs once" color="var(--dim)" mem="one-shot" />
              <Svc name="Cron" detail="Alpine crond . HMAC-signed reqs" color="var(--amber)" mem="~32M" />
            </div>
          </Zone>
        </Zone>
      </div>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 2: The Unlock                                   */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">The Unlock</div>
      <h2>
        Code execution + autonomous agents.{" "}
        <span className="hl">Then it builds itself.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The platform has the filesystem, the data, the permissions, the AI.
        Two capabilities complete the picture: agents that run autonomously in
        loops, and containers where code actually executes. These are the last
        mile &mdash; not missing features, but the unlock that turns a
        collaboration platform into a self-extending OS.
      </p>

      <FeatureRow columns={2}>
        <Feature
          icon="&#x1F527;"
          nameColor="var(--blue)"
          name="Autonomous agents"
          description="Agents that plan, execute, evaluate, and loop. Not request-bound &mdash; always-on. They schedule themselves via calendar events, decompose work into task lists, delegate via <code>ask_agent</code>. The workspace IS the orchestration layer. Add a loop and it comes alive."
        />
        <Feature
          icon="&#x1F4BB;"
          nameColor="var(--violet)"
          name="Code execution"
          description="Containers with real shells, real git, real filesystems. A BRANCH page spawns a VM. Delete the page, destroy the container. Agent processes run inside. The page tree IS the infrastructure. PageSpace goes from storing data to running programs."
        />
      </FeatureRow>

      <Card accent="blue">
        <h4 style={{ color: "var(--blue)" }}>Why both matter together</h4>
        <p style={{ fontSize: 12 }}>
          A runtime without code execution is just a chatbot. Code execution
          without a runtime is just a hosted IDE. Together they create
          something new: a platform where your data, your agents, and your
          apps all live in the same place. A repo inside PageSpace is a
          drive (for the team) and a deployable app (built by agents) at the
          same time. The platform starts building its own interfaces, its own
          tools, its own workflows &mdash; from the inside.
        </p>
      </Card>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 3: The Roadmap                                  */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">The Roadmap</div>
      <h2>
        Infrastructure, runtime, then{" "}
        <span className="hl">interfaces on the engine.</span>
      </h2>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        The agent runtime and coding environment are the same problem
        &mdash; agents need somewhere to run code, and that somewhere
        needs per-org isolation to exist. Once the engine is running,
        every vertical (CMS, CRM, industry-specific) follows the same
        pattern: a custom interface on top of PageSpace.
      </p>

      <ArchDiagram>
        <ArchRow label="Today" labelSub="live" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Workspace Lens"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.4)"
            style={{ border: "2px solid rgba(61,214,140,0.4)" }}
            detail="Filesystem, permissions, processes, networking, storage &mdash; live.<br>Agents have 33+ tools but no loops, no shell.<br>Request-bound. No code execution. No per-org isolation."
          />
        </ArchRow>

        <ArchConnector text="the architecture has to shift before anything else can happen" />

        <ArchRow label="Infra" labelSub="next" style={{ marginBottom: 8 }}>
          <ArchNode
            title="AWS Migration"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            detail="AWS &mdash; ECS, RDS, ElastiCache, S3. Autoscaling.<br>Per-org isolation: schema split (~40 global + ~45 per-org),<br>dedicated resources per paid org. Not optional &mdash;<br>containers can&apos;t exist without org-level isolation underneath."
          />
          <ArchNode
            title="Runtime + Containers"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            detail="Agent loops (plan &rarr; execute &rarr; evaluate) and code execution<br>are the same service. Runtime spawns VMs, agents run inside.<br>BRANCH page = container. Delete page = destroy container."
          />
        </ArchRow>

        <ArchConnector text="agents can run code &rarr; the IDE lens emerges" />

        <ArchRow label="IDE" labelSub="bootstrap" style={{ marginBottom: 8 }}>
          <ArchNode
            title="IDE Lens"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.4)"
            style={{ border: "2px solid rgba(34,211,238,0.4)" }}
            detail="Terminal, git, file browser, BRANCH pages, agents in containers.<br>The IDE is the bootstrap &mdash; the first interface that enables all others.<br>Once agents can write and execute code, they can build new interfaces."
          />
        </ArchRow>

        <ArchConnector text="custom interfaces on the engine &mdash; all the same pattern" />

        <ArchRow label="Verticals" labelSub="interfaces">
          <ArchNode
            title="CMS"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Pages become publishable content &mdash; blogs, courses, docs, sites.<br>Drives become deployable properties with build pipelines.<br>Custom domains, SSL. Agents maintain and publish content."
          />
          <ArchNode
            title="CRM"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            detail="Pages as contacts, drives as pipelines. Sidebar already provides<br>per-page navigation. Needs custom interface + external integrations<br>(email, Slack, calendar). Longest dependency chain."
          />
          <ArchNode
            title="Industry Verticals"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            detail="Same pattern as CMS and CRM &mdash; custom interfaces and<br>workflows optimized for a specific domain. Industry partners<br>configure and resell PageSpace built for their market."
          />
        </ArchRow>
      </ArchDiagram>

      <Card accent="blue" style={{ marginBottom: 24 }}>
        <h4 style={{ color: "var(--blue)" }}>CMS, CRM, and franchises are the same idea</h4>
        <p style={{ fontSize: 12 }}>
          A CMS is a custom interface that shows pages as publishable content.
          A CRM is a custom interface that shows pages as contacts and pipelines.
          An industry vertical is a custom interface optimized by someone who
          knows that industry. They all follow the same model: a lens on
          PageSpace as an engine, with domain-specific workflows and navigation.
          The IDE is what makes building these interfaces possible.
        </p>
      </Card>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 4: Target Architecture                          */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Target</div>
      <h2>
        Per-org isolation.{" "}
        <span className="hl">The engine underneath.</span>
      </h2>

      <MigrationArrow label="where the roadmap leads" />

      <div style={{ background: "var(--s1)", border: "1px solid var(--border)", borderRadius: 14, padding: 16, marginBottom: 24 }}>
        <Zone label="Global" color="var(--green)" badge="AWS . shared across all orgs">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
            <Svc name="Global Postgres (RDS)" detail="~40 tables: users, auth, billing, DMs, monitoring" color="var(--green)" />
            <Svc name="Auth" detail="Opaque tokens . passkeys . OAuth . sessions" color="var(--red)" />
            <Svc name="Billing" detail="Stripe . subscriptions . tiers" color="var(--amber)" />
            <Svc name="Control Plane" detail="Provisioner . lifecycle . health" color="var(--amber)" />
          </div>

          <Flow label="provisions + auth" color="var(--green)" />

          <div style={{ display: "grid", gridTemplateColumns: "2fr 5fr", gap: 10 }}>
            <Zone label="Shared" color="var(--dim)" badge="free" style={{ opacity: 0.8 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <Svc name="Shared Postgres" detail="Row isolation by orgId" />
                <Svc name="Web + Realtime" detail="Shared ECS tasks" />
                <Svc name="Redis" detail="Shared cache" />
              </div>
            </Zone>

            <Zone label="Team Org" color="var(--blue)" badge="AWS . paid . dedicated">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5, marginBottom: 8 }}>
                <Svc name="Org Postgres (RDS)" detail="~45 tables . dedicated . AI billing, API keys" color="var(--blue)" />
                <Svc name="Redis" detail="ElastiCache . dedicated" color="var(--cyan)" />
                <Svc name="S3" detail="File storage" color="var(--amber)" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 5, marginBottom: 8 }}>
                <Svc name="Web" detail="Dedicated ECS" color="var(--cyan)" />
                <Svc name="Realtime" detail="Socket.IO" color="var(--cyan)" />
                <Svc name="Processor" detail="Files . OCR" color="var(--cyan)" />
                <Svc name="Runtime" detail="Agent loops . scheduling . workflows" color="var(--blue)" />
              </div>

              <Flow label="spawns VMs" color="var(--violet)" />

              <Zone label="Execution" color="var(--violet)" badge="Firecracker VMs">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <Zone label="main" color="var(--violet)" style={{ padding: "22px 10px 10px" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <Svc name="VM" detail="Isolated . shell . git" color="var(--violet)" />
                      <Svc name="Turso" detail="Synced from Org PG" />
                      <div style={{ display: "flex", gap: 3 }}>
                        <Svc name="Agent" detail="impl" color="var(--violet)" />
                        <Svc name="Agent" detail="review" color="var(--violet)" />
                      </div>
                    </div>
                  </Zone>
                  <Zone label="feature/branch" color="var(--violet)" style={{ padding: "22px 10px 10px" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <Svc name="VM" detail="Parallel . isolated" color="var(--violet)" />
                      <Svc name="Turso" detail="Independent state" />
                      <Svc name="Agent" detail="coding" color="var(--violet)" />
                    </div>
                  </Zone>
                </div>
              </Zone>

              <Flow label="publishes apps + content" color="var(--green)" />

              <Zone label="Publishing" color="var(--green)" badge="published pages + apps">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 }}>
                  <Svc name="Subdomain Routing" detail="org.pagespace.ai . custom domains" color="var(--green)" />
                  <Svc name="Build Pipeline" detail="Pages &rarr; deployable sites . SSL" color="var(--green)" />
                  <Svc name="CDN" detail="Edge cache . static assets" color="var(--green)" />
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
          <span><strong style={{ color: "var(--green)" }}>Global:</strong> 1x RDS &middot; ~40 tables</span>
          <span style={{ color: "var(--border)" }}>|</span>
          <span><strong style={{ color: "var(--blue)" }}>Per org:</strong> 1x RDS &middot; 1x Redis &middot; 1x S3 &middot; 4x ECS &middot; Nx VMs</span>
          <span style={{ color: "var(--border)" }}>|</span>
          <span><strong style={{ color: "var(--green)" }}>Publishing:</strong> subdomain routing &middot; CDN &middot; SSL</span>
          <span style={{ color: "var(--border)" }}>|</span>
          <span><strong style={{ color: "var(--dim)" }}>Free:</strong> shared &middot; row isolation</span>
        </div>
      </div>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 5: Deep Dives                                   */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Deep Dives</div>
      <h2>
        Explore the{" "}
        <span className="hl">details.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Each subsystem has its own deep dive in the navigation above.
        Here&apos;s what you&apos;ll find.
      </p>

      <div className="g4" style={{ marginBottom: 12 }}>
        <Card accent="blue">
          <h4 style={{ color: "var(--blue)" }}>Runtime</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>Agent execution model, loop design, scheduling, budget metering</p>
        </Card>
        <Card accent="green">
          <h4 style={{ color: "var(--green)" }}>Memory</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>Scoped agent memory, entity state, Turso sync</p>
        </Card>
        <Card accent="cyan">
          <h4 style={{ color: "var(--cyan)" }}>RAG &amp; Search</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>Semantic search, pgvector, knowledge graph</p>
        </Card>
        <Card accent="amber">
          <h4 style={{ color: "var(--amber)" }}>Governance</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>RBAC, org layer, budgets, capability gates</p>
        </Card>
      </div>
      <div className="g4" style={{ marginBottom: 12 }}>
        <Card accent="violet">
          <h4 style={{ color: "var(--violet)" }}>Observability</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>Audit logs, turn logs, monitoring, SIEM</p>
        </Card>
        <Card accent="cyan">
          <h4 style={{ color: "var(--cyan)" }}>Integrations</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>MCP, channel adapters, OAuth, credential vault</p>
        </Card>
        <Card accent="green">
          <h4 style={{ color: "var(--green)" }}>Database</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>89 tables, schema split plan, per-org isolation</p>
        </Card>
        <Card accent="blue">
          <h4 style={{ color: "var(--blue)" }}>Interfaces</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>IDE, CMS, CRM &mdash; three lenses on the OS</p>
        </Card>
      </div>
      <div className="g4">
        <Card accent="red">
          <h4 style={{ color: "var(--red)" }}>Compliance</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>GDPR, SOC 2, HIPAA deep dives</p>
        </Card>
        <Card accent="green">
          <h4 style={{ color: "var(--green)" }}>User Stories</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>70+ live stories, feature inventory by persona</p>
        </Card>
        <Card accent="violet">
          <h4 style={{ color: "var(--violet)" }}>Epics &amp; Tasks</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>Phase-by-phase task breakdown with status</p>
        </Card>
        <Card>
          <h4 style={{ color: "var(--dim)" }}>Security</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>Encryption, sandboxing, audit chain, threat model</p>
        </Card>
      </div>
    </div>
  );
}
