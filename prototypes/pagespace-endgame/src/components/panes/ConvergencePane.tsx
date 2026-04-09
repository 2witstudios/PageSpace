import type { CSSProperties } from "react";
import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";

const cellTd: CSSProperties = {
  padding: "8px 14px",
  borderBottom: "1px solid rgba(42,42,61,0.5)",
  fontSize: 12,
  verticalAlign: "top",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  fontSize: 10,
  fontWeight: 600,
  color: "var(--dim)",
  letterSpacing: 1.2,
  textTransform: "uppercase",
  padding: "8px 14px",
  borderBottom: "1px solid var(--border)",
};

export function ConvergencePane() {
  return (
    <div className="pane-wide">
      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 1: The Question                                */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">The Question</div>
      <h2>
        What are the boundaries{" "}
        <span className="hl">
          between PageSpace and Parallax?
        </span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        We forked OpenFang &mdash; an open-source Rust Agent OS &mdash; to
        build Parallax. But PageSpace already has an agent runtime (14 tool
        modules, cron + event triggers live, agent-to-agent delegation), the
        page tree already functions as a filesystem, and the roadmap calls
        for containers and code execution. The boundary question isn&apos;t
        theoretical &mdash; PageSpace is already a harness. So what does
        maintaining a separate Rust fork actually add?
      </p>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 2: What OpenFang Solved                        */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">What OpenFang Solved</div>
      <h2>
        Problems already solved{" "}
        <span className="hl">in the ecosystem.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        OpenFang is a mature open-source project &mdash; 137K lines of Rust
        across 14 crates, 1,767+ tests, battle-tested. These are the
        capabilities it provides that are directly relevant to
        PageSpace&apos;s execution gap.
      </p>

      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--cyan)"
          name="WASM sandbox"
          description="Wasmtime with fuel metering + epoch interruption. Watchdog thread kills runaway code. Per-agent CPU and memory budgets. 16 security layers including Merkle audit trail, Ed25519 signed manifests, taint tracking, and prompt injection scanning."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="8 autonomous Hands"
          description="Researcher (7-phase deep research with CRAAP source evaluation), Clip (video-to-shorts pipeline), Lead (ICP-matching discovery), Collector (OSINT monitoring), Predictor (superforecasting), Twitter, Browser (with purchase approval gates), Trader. Each bundles a HAND.toml manifest, 500+ word system prompt, and domain expertise."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="40 channel adapters"
          description="7 core (Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Email), 6 enterprise, 8 social, 7 community, 7 privacy, 5 workplace. Per-channel model overrides and DM/group policies. PageSpace has Slack only."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--cyan)"
          name="6-layer memory"
          description="KV store, vector embeddings, knowledge graph, session manager, task board, canonical cross-channel sessions. All in SQLite per agent. PageSpace has page-tree persistence and conversation history but no embeddings, no semantic retrieval, no graph structure."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Single-binary deployment"
          description="~32MB Rust binary. curl | sh install. 180ms cold start, 40MB RAM. 30+ pre-configured agent templates. Python + JS SDKs. OFP P2P wire protocol for agent-to-agent networking."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="60 skills + 25 MCP templates"
          description="60 bundled skills compiled into the binary. 25 MCP server templates (AWS, GitHub, Jira, Linear, Notion, PostgreSQL, MongoDB, etc.). FangHub + ClawHub marketplace for community Hands and skills."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 3: Three Options                               */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Options</div>
      <h2>
        Two paths.{" "}
        <span className="hl">Each with real trade-offs.</span>
      </h2>

      <div className="g2" style={{ marginBottom: 24 }}>
        <Card accent="violet">
          <h4 style={{ color: "var(--violet)" }}>
            Parallax = harness, PageSpace = memory + interface
          </h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            The discussed boundary. Parallax (the OpenFang fork) is the
            agent harness &mdash; runtime, execution, scheduling. PageSpace
            is the cloud memory and interface layer &mdash; persistent state,
            team workspace, the UI humans interact with. Parallax agents
            read and write to PageSpace the way local agents read and write
            to a filesystem.
          </p>
          <p style={{ marginTop: 10, fontSize: 11, color: "var(--dim)" }}>
            <strong style={{ color: "var(--green)" }}>Gets you:</strong>{" "}
            8 ready-made Hands, 30+ agent templates, 40 channel adapters,
            6-layer memory with knowledge graphs, Python + JS SDKs, OFP
            P2P wire protocol. PageSpace provides what OpenFang lacks
            (cloud state, team awareness, 75-table database, RBAC, UI).
            <br />
            <strong style={{ color: "var(--amber)" }}>Costs:</strong>{" "}
            Maintaining a Rust fork alongside a TypeScript platform. Two
            codebases with overlapping agent runtime concepts. Engineering
            bandwidth split.
            <br />
            <strong style={{ color: "var(--red)" }}>The tension:</strong>{" "}
            PageSpace agents already execute autonomously (cron + event
            triggers live), already delegate agent-to-agent (2 levels deep),
            already have per-user permission isolation. 14 tool modules
            across page CRUD, search, tasks, calendar, channels. The page
            tree is the filesystem. If the &ldquo;memory&rdquo; is also the
            thing agents operate on, read from, write to, and get triggered
            by &mdash; that&apos;s a harness, which blurs the boundary this
            option tries to draw.
          </p>
        </Card>

        <Card accent="green">
          <h4 style={{ color: "var(--green)" }}>
            Just build PageSpace
          </h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Follow the existing roadmap: per-org isolation, Firecracker
            containers, BRANCH pages, IDE lens. The page tree is already
            the filesystem. Agents are already the processes. Containers
            are the execution environment. It&apos;s already a harness
            &mdash; just finish building it. One codebase, one team, no fork.
          </p>
          <p style={{ marginTop: 10, fontSize: 11, color: "var(--dim)" }}>
            <strong style={{ color: "var(--green)" }}>Gets you:</strong>{" "}
            Simplest path. One codebase with 75 tables, 14 tool modules,
            cron + events already live, RBAC already enforced, org billing
            branch ready to merge. MCP client via desktop bridge. All
            engineering focused on one product.
            <br />
            <strong style={{ color: "var(--amber)" }}>Costs:</strong>{" "}
            Miss OpenFang&apos;s 8 Hands, 60 skills, 40 channel adapters,
            6-layer memory with knowledge graphs, WASM isolation, and edge
            deployment. The declarative HAND.toml pattern. Taint tracking
            and Merkle audit trail.
          </p>
        </Card>
      </div>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 4: The Overlap                                 */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Overlap</div>
      <h2>
        Where they duplicate{" "}
        <span className="hl">and where they diverge.</span>
      </h2>

      <Card style={{ overflow: "auto", marginBottom: 24, padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={thStyle}>Capability</th>
              <th style={{ ...thStyle, color: "var(--green)" }}>PageSpace</th>
              <th style={{ ...thStyle, color: "var(--cyan)" }}>OpenFang</th>
              <th style={thStyle}>Verdict</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Agent runtime</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>TS finish-tool loop (LLM controls termination). Vercel AI SDK, 10 providers, 100+ models.</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Rust kernel with 14-step deterministic boot. 3 native LLM drivers, 27 providers, 123+ models.</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>Both solve the loop. Different languages and isolation.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Tools</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>14 modules (page, drive, search, task, calendar, channel, delegation). Workspace-scoped, permission-gated per user.</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>23 built-in tools + browser sub-tools. Machine-scoped, WASM-sandboxed. Capability gates on every call.</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>Duplicated effort. Different scoping models.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Memory</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Page tree + 75-table Postgres. Conversation persistence. No embeddings or semantic search.</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>6-layer SQLite: KV, vectors, knowledge graph, sessions, tasks, canonical. All per-agent.</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>OpenFang has richer primitives. PageSpace has team-shared persistence.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Scheduling</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Cron + event triggers (both live). 30s debounce, folder-scoped, recursive prevention. 5 concurrent, 10min timeout.</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Cron-native Hands. 8 pre-built autonomous workflows with multi-phase playbooks and approval gates.</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>Both have cron. OpenFang&apos;s Hands are richer than cron + prompt.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>MCP</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Client via desktop WebSocket bridge. MCP as integration provider type. Not a standalone server.</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Client + server. 25 pre-built MCP server templates (AWS, GitHub, Jira, Linear, Notion, Postgres).</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>Both support MCP. OpenFang has deeper template library.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Channels</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Web UI + Slack adapter (OAuth2, live). @agent mentions in PageSpace channels.</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>40 adapters across core, enterprise, social, community, privacy, workplace categories.</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>Clear OpenFang strength. PageSpace has 1.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Security</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Per-user RBAC, page-level permissions, MCP token scoping, audit logs, permission caching.</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>16 layers: WASM dual-metering, Merkle audit trail, Ed25519 manifests, taint tracking, prompt injection scanner.</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>Different models. Team governance vs kernel-level enforcement.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Agent ecosystem</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Skill index planned. Integration tools resolved at runtime per agent.</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>30+ agent templates, 8 Hands, 60 bundled skills, FangHub marketplace.</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>OpenFang has depth. PageSpace has the platform.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)" }}>Multi-tenancy</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Full: RBAC, drives, billing. Org branch ready to merge (Stripe, scope inheritance).</td>
              <td style={{ ...cellTd, color: "var(--mid)" }}>Single-user by design.</td>
              <td style={{ ...cellTd, color: "var(--dim)" }}>Clear PageSpace strength.</td>
            </tr>
            <tr>
              <td style={{ ...cellTd, fontWeight: 600, color: "var(--text)", borderBottom: "none" }}>Deployment</td>
              <td style={{ ...cellTd, color: "var(--mid)", borderBottom: "none" }}>Cloud SaaS, self-hosted Docker, Electron desktop, Capacitor mobile.</td>
              <td style={{ ...cellTd, color: "var(--mid)", borderBottom: "none" }}>Single ~32MB binary. 180ms cold start, 40MB RAM. Edge-native.</td>
              <td style={{ ...cellTd, color: "var(--dim)", borderBottom: "none" }}>Fundamentally different models.</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 5: Worth Stealing                              */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Patterns</div>
      <h2>
        Worth stealing{" "}
        <span className="hl">regardless of which option wins.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Whatever strategic direction we pick, these OpenFang patterns solve
        problems PageSpace has. They&apos;re architectural concepts, not
        code &mdash; they can be implemented in TypeScript without porting
        Rust.
      </p>

      <FeatureRow columns={2}>
        <Feature
          nameColor="var(--green)"
          name="Agent sandboxing"
          description="OpenFang's dual metering (fuel counting + epoch interruption simultaneously, with watchdog thread) is more granular than single-mechanism container limits. PageSpace workflows currently run in the main Node.js process &mdash; no isolation. The pattern: agents run in sandboxed environments with resource limits, never in the main process."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="6-layer memory substrate"
          description="KV store, vector embeddings, knowledge graph, session manager, task board, canonical sessions &mdash; all in SQLite per agent. PageSpace has page-tree persistence and conversation history, but no embeddings or semantic retrieval. The pattern: structured knowledge accumulation beyond conversation logs."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>
      <FeatureRow columns={2}>
        <Feature
          nameColor="var(--green)"
          name="Channel adapter pattern"
          description="40 adapters with a consistent interface: receive from channel, route to agent, send response. Per-channel model overrides, DM/group policies, output formatting (Markdown&rarr;TelegramHTML/SlackMrkdwn). PageSpace has Slack only. The pattern: a pluggable adapter layer so agents are reachable from anywhere."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Declarative Hands"
          description="Each Hand bundles a HAND.toml manifest, multi-phase system prompt (500+ words), domain expertise reference, and approval gates. The Researcher Hand has 7 phases (decomposition &rarr; multi-strategy search &rarr; CRAAP evaluation &rarr; cross-reference &rarr; report). This is richer than cron + prompt. The pattern: autonomous operational playbooks, not just scheduled prompts."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <hr />

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 6: The Decision                                */}
      {/* ═══════════════════════════════════════════════════════ */}

      <div className="sl">Decision</div>
      <h2>
        What should we optimize for?
      </h2>

      <Card accent="blue" style={{ marginBottom: 12 }}>
        <h4 style={{ color: "var(--blue)" }}>Decision criteria</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          <strong>Engineering bandwidth</strong> &mdash; Can we afford to
          maintain a Rust fork and a TypeScript platform simultaneously?
          <br /><br />
          <strong>Fork maintenance cost</strong> &mdash; OpenFang is
          actively developed upstream (v0.5.1, pre-1.0). How much effort
          is staying current? Does the fork diverge or stay close?
          <br /><br />
          <strong>Time to market</strong> &mdash; Which path gets to code
          execution fastest? PageSpace has cron + events live but no
          sandboxing. OpenFang has sandboxing live but no team layer.
          <br /><br />
          <strong>Org branch readiness</strong> &mdash; The org billing
          branch is ready to merge (Stripe, scope inheritance, delegation
          chains). That gives PageSpace the governance foundation both
          paths require.
          <br /><br />
          <strong>The cloud memory question</strong> &mdash; If Parallax
          is the cloud memory layer for OpenFang agents, that may be a
          different product than PageSpace. But PageSpace&apos;s page tree
          already IS cloud memory that agents read and write. Does a
          separate codebase add something the page tree can&apos;t?
          <br /><br />
          <strong>Product differentiation</strong> &mdash; Does having both
          a local agent runtime and a cloud team platform give Parallel
          Drive something competitors can&apos;t match? Or does it dilute
          focus?
        </p>
      </Card>
    </div>
  );
}
