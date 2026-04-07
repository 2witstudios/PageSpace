import { Card } from "../ui/Card";
import { Pill } from "../ui/Pill";
import {
  DagContainer,
  DagRow,
  DagNode,
  DagVertical,
} from "../ui/DagDiagram";

/* ── Shared styles ── */
const epicHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 6,
};

const epicTitle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
};

const prList: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 11,
  lineHeight: 2,
  color: "var(--mid)",
  margin: 0,
  padding: "8px 0 0 0",
  listStyle: "none",
};

const prNum: React.CSSProperties = {
  color: "var(--cyan)",
  fontWeight: 600,
  marginRight: 6,
};

const refTag: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 9,
  color: "var(--dim)",
  background: "var(--s3)",
  padding: "2px 6px",
  borderRadius: 4,
  marginLeft: 6,
};

function Ref({ tab, section }: { tab: string; section?: string }) {
  return (
    <span style={refTag}>
      {tab}
      {section ? ` → ${section}` : ""}
    </span>
  );
}

function PR({ n, desc }: { n: number; desc: string }) {
  return (
    <li>
      <span style={prNum}>PR {n}</span>
      {desc}
    </li>
  );
}

/* ── Project section component ── */
function ProjectSection({
  number,
  name,
  color,
  description,
  depends,
  children,
}: {
  number: string;
  name: string;
  color: string;
  description: string;
  depends?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--dim)",
          }}
        >
          {number}
        </span>
        <h3 style={{ color, margin: 0 }}>{name}</h3>
        {depends && (
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 9,
              color: "var(--dim)",
            }}
          >
            depends on {depends}
          </span>
        )}
      </div>
      <p style={{ marginBottom: 16, fontSize: 12.5 }}>{description}</p>
      <div className="g2">{children}</div>
    </div>
  );
}

export function ProjectsPane() {
  return (
    <div className="pane">
      {/* ── Intro ── */}
      <div className="sl">Build Plan</div>
      <h2>
        How to build everything on this site in{" "}
        <span className="hl">shippable increments.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        The other tabs describe{" "}
        <strong>what</strong> Pagespace CLI is. This tab describes{" "}
        <strong>how to build it</strong> — organized into projects, broken into
        epics, each epic scoped as a sequence of incremental PRs. Every epic
        cross-references the tab where its target feature is specified.
      </p>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        The priority: get a single agent streaming in a browser first.
        Everything else is N of that with coordination, scoring, and UI.
      </p>

      {/* ── Project dependency DAG ── */}
      <div className="sl">Project Dependencies</div>
      <DagContainer>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--dim)",
            marginBottom: 16,
            textAlign: "center",
          }}
        >
          P1 is the foundation &mdash; everything else builds on top
        </div>
        <DagRow>
          <DagNode type="P1" name="Core Agent Runtime" color="blue" />
        </DagRow>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            margin: "8px 0",
          }}
        >
          <DagVertical label="unlocks" color="var(--blue)" />
        </div>
        <DagRow>
          <DagNode type="P2" name="Containers" color="cyan" />
          <DagNode type="P3" name="Entity State" color="green" />
          <DagNode type="P4" name="Orchestration UI" color="violet" />
        </DagRow>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            margin: "8px 0",
          }}
        >
          <DagVertical label="unlocks" color="var(--dim)" />
        </div>
        <DagRow>
          <DagNode type="P5" name="Orchestration" color="amber" />
          <DagNode type="P6" name="Quality Pipeline" color="red" />
          <DagNode type="P7" name="Skills System" color="violet" />
        </DagRow>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            margin: "8px 0",
          }}
        >
          <DagVertical label="unlocks" color="var(--dim)" />
        </div>
        <DagRow>
          <DagNode type="P8" name="Search & Analytics" color="amber" />
        </DagRow>
      </DagContainer>

      {/* ── Legend ── */}
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 28,
        }}
      >
        <Pill variant="blue">project</Pill>
        <Pill variant="violet">epic</Pill>
        <Pill variant="dim">PR scope</Pill>
        <span style={{ fontSize: 11, color: "var(--dim)", alignSelf: "center" }}>
          Tab references shown as{" "}
          <span style={refTag}>Tab → Section</span>
        </span>
      </div>

      <hr />

      {/* ═══════════ P1: Core Agent Runtime ═══════════ */}
      <ProjectSection
        number="P1"
        name="Core Agent Runtime"
        color="var(--blue)"
        description="The foundation. One agent context streaming to a browser. Then loops, sub-agents, and isolation. Nothing else works without this."
      >
        <Card accent="blue">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--blue)" }}>
              E1.1 Container Provisioning &amp; Streaming
            </span>
            <Ref tab="Architecture" section="Three Layers" />
          </div>
          <p style={{ fontSize: 12 }}>
            Create a BRANCH page that spins up a cloud container. Spawn a
            single agent process inside it. Stream output to PageSpace over
            WebSocket. This is the "start here" from the Decisions tab.
          </p>
          <ul style={prList}>
            <PR n={1} desc="WebSocket server + connection auth" />
            <PR n={2} desc="Agent process spawning (PTY in container)" />
            <PR n={3} desc="Message protocol (agent ↔ server ↔ browser)" />
            <PR n={4} desc="React streaming view component" />
            <PR n={5} desc="Basic lifecycle (start, kill, reconnect)" />
          </ul>
        </Card>

        <Card accent="blue">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--blue)" }}>
              E1.2 Agent Loop
            </span>
            <Ref tab="Architecture" section="Three Layers" />
          </div>
          <p style={{ fontSize: 12 }}>
            Replace single-turn tool calls with real planning loops.
            Plan → execute → evaluate → loop until gate passes or plan
            completes.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Loop state machine (plan/execute/evaluate/done)" />
            <PR n={2} desc="Gate evaluation (pass/partial/fail routing)" />
            <PR n={3} desc="Token budget + max-iteration bounds" />
            <PR n={4} desc="Loop observability (stream state transitions to UI)" />
          </ul>
        </Card>

        <Card accent="blue">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--blue)" }}>
              E1.3 Sub-agent Spawning
            </span>
            <Ref tab="Architecture" section="Page Tree" />
          </div>
          <p style={{ fontSize: 12 }}>
            Parent agents spawn child agents as child pages. Parent monitors
            and delegates. Visible as nested conversations in the sidebar.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Child agent spawn API + parent pointer" />
            <PR n={2} desc="Parent ↔ child message passing" />
            <PR n={3} desc="Child completion → parent resume" />
            <PR n={4} desc="Nested chat tree rendering in sidebar" />
          </ul>
        </Card>

        <Card accent="blue">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--blue)" }}>
              E1.4 Context Isolation
            </span>
            <Ref tab="Agent Isolation" />
          </div>
          <p style={{ fontSize: 12 }}>
            Enforce the three-boundary model: implementation, review, and
            meta-review contexts are strictly separated. No agent grades its
            own work.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Context type enum + visibility rules" />
            <PR n={2} desc="Input filtering (what each context type can see)" />
            <PR n={3} desc="Isolation tests (verify no info leakage)" />
          </ul>
        </Card>
      </ProjectSection>

      <hr />

      {/* ═══════════ P2: Branch Containers ═══════════ */}
      <ProjectSection
        number="P2"
        name="BRANCH Page Type &amp; Containers"
        color="var(--cyan)"
        description="New page type backed by cloud containers. Create a BRANCH page → container spins up with that branch checked out. AI_CHAT children run agents inside. The Pagespace CLI is pre-installed."
        depends="P1"
      >
        <Card accent="cyan">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--cyan)" }}>
              E2.1 Container Provisioning
            </span>
            <Ref tab="Containers" section="Lifecycle" />
          </div>
          <p style={{ fontSize: 12 }}>
            Create branch → spin up container → copy env → full repo checkout.
            Containers destroyed on branch delete.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Container image + build pipeline" />
            <PR n={2} desc="Branch → container creation API" />
            <PR n={3} desc="Env copy + git clone into container" />
            <PR n={4} desc="Container destroy on branch delete" />
          </ul>
        </Card>

        <Card accent="cyan">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--cyan)" }}>
              E2.2 Multi-agent per Container
            </span>
            <Ref tab="Containers" section="Agents + Terminals" />
          </div>
          <p style={{ fontSize: 12 }}>
            Multiple agent processes and terminal sessions inside one container,
            each visible as a pane. Shared filesystem, isolated processes.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Process multiplexer inside container" />
            <PR n={2} desc="Terminal session spawning + PTY proxy" />
            <PR n={3} desc="Agent ↔ terminal isolation (separate PIDs)" />
            <PR n={4} desc="Multi-pane routing (which pane → which process)" />
          </ul>
        </Card>

        <Card accent="cyan">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--cyan)" }}>
              E2.3 Multi-repo
            </span>
            <Ref tab="Containers" section="Multi-Repo" />
          </div>
          <p style={{ fontSize: 12 }}>
            Each drive is a repo. Drives show their BRANCH pages and agents
            in PageSpace's sidebar. Cross-repo coordination for related features.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Repo registry + sidebar tree data model" />
            <PR n={2} desc="Per-repo BRANCH page + container management" />
            <PR n={3} desc="Cross-repo plan linking" />
          </ul>
        </Card>
      </ProjectSection>

      <hr />

      {/* ═══════════ P3: Entity State & Traceability ═══════════ */}
      <ProjectSection
        number="P3"
        name="Entity State &amp; Traceability"
        color="var(--green)"
        description="Every artifact is a tracked entity. Every change links back to why it exists. The data model that makes everything queryable."
        depends="P1"
      >
        <Card accent="green">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--green)" }}>
              E3.1 Entity State Layer
            </span>
            <Ref tab="Data Model" />
            <Ref tab="Decisions" section="Open Questions" />
          </div>
          <p style={{ fontSize: 12 }}>
            Define core entities (Plan, Task, AgentContext, Mutation, Commit,
            PR) and choose the state layer. Candidates: Drizzle tables in
            PageSpace's existing PostgreSQL, ECS via @adobe/data, SQLite via
            Turso in containers, or a hybrid. See Decisions tab — this is an
            open question.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Entity schema definitions (implementation-agnostic)" />
            <PR n={2} desc="State layer spike: evaluate ECS vs Turso vs Drizzle" />
            <PR n={3} desc="Implement chosen layer + entity registration" />
            <PR n={4} desc="Relationship indexing (bidirectional links)" />
          </ul>
        </Card>

        <Card accent="green">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--green)" }}>
              E3.2 Mutation &amp; Commit Tracking
            </span>
            <Ref tab="Data Model" section="Traceability" />
          </div>
          <p style={{ fontSize: 12 }}>
            Every file change captured as a Mutation entity. Git commits
            indexed and linked back to the agent context and plan node that
            produced them.
          </p>
          <ul style={prList}>
            <PR n={1} desc="File watcher → Mutation entity creation" />
            <PR n={2} desc="Git commit hook → Commit entity + mutation linking" />
            <PR n={3} desc="Plan node attribution (mutation → plan_node)" />
            <PR n={4} desc="PR grouping (same-task commits → PR entity)" />
          </ul>
        </Card>

        <Card accent="green">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--green)" }}>
              E3.3 Context Logging
            </span>
            <Ref tab="Agent Isolation" section="Context Logging" />
          </div>
          <p style={{ fontSize: 12 }}>
            Every LLM call recorded as a TurnLog: exact system prompt,
            messages sent, model, tokens, latency, raw response. Full
            auditability.
          </p>
          <ul style={prList}>
            <PR n={1} desc="TurnLog entity + capture middleware" />
            <PR n={2} desc="System prompt + message array serialization" />
            <PR n={3} desc="Token count + latency tracking" />
            <PR n={4} desc="TurnLog → UI viewer (inspect any agent decision)" />
          </ul>
        </Card>

        <Card accent="green">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--green)" }}>
              E3.4 Agent Memory
            </span>
            <Ref tab="Agent Isolation" section="Memory" />
          </div>
          <p style={{ fontSize: 12 }}>
            Persistent key-value store scoped at four levels: per-context,
            per-task, per-plan, global. Memory entries trace back to the
            TurnLog that created them.
          </p>
          <ul style={prList}>
            <PR n={1} desc="AgentMemory entity + scope enum" />
            <PR n={2} desc="Read/write API with scope resolution" />
            <PR n={3} desc="Memory → TurnLog provenance linking" />
            <PR n={4} desc="Expiration + cleanup for scoped memories" />
          </ul>
        </Card>
      </ProjectSection>

      <hr />

      {/* ═══════════ P4: PageSpace Orchestration UI ═══════════ */}
      <ProjectSection
        number="P4"
        name="PageSpace Orchestration UI"
        color="var(--violet)"
        description="Extensions to PageSpace's existing web UI for BRANCH pages, agent status, container health, and orchestration observability. No separate app — these are features within PageSpace."
        depends="P1"
      >
        <Card accent="violet">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--violet)" }}>
              E4.1 BRANCH Page Type UI
            </span>
            <Ref tab="Interface" section="Agent Management" />
          </div>
          <p style={{ fontSize: 12 }}>
            New page type in PageSpace's sidebar. Container status indicators.
            Create/destroy lifecycle. Child pages (agents, docs) nested beneath.
            Collapsible with agent count badges.
          </p>
          <ul style={prList}>
            <PR n={1} desc="BRANCH page type registration + creation flow" />
            <PR n={2} desc="Container provisioning on BRANCH page create" />
            <PR n={3} desc="Sidebar rendering with status indicators" />
            <PR n={4} desc="Container destroy on BRANCH page delete" />
          </ul>
        </Card>

        <Card accent="violet">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--violet)" }}>
              E4.2 Agent Status &amp; Monitoring
            </span>
            <Ref tab="Interface" section="Observability" />
          </div>
          <p style={{ fontSize: 12 }}>
            Agent status indicators on AI_CHAT pages in the sidebar
            (running/idle/failed). Container health views. Live updates via
            Socket.IO. Integrated into PageSpace's existing UI framework.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Agent status enum + Socket.IO status events" />
            <PR n={2} desc="Sidebar badges (running/idle/failed)" />
            <PR n={3} desc="Container health panel on BRANCH page view" />
            <PR n={4} desc="Agent process list + kill/restart controls" />
          </ul>
        </Card>

        <Card accent="violet">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--violet)" }}>
              E4.3 Conversation &amp; Memory Browser
            </span>
            <Ref tab="Interface" section="Observability" />
          </div>
          <p style={{ fontSize: 12 }}>
            Enhanced conversation history views for agent interactions. Memory
            browser for persistent agent memory. Context window inspector for
            debugging. Built on PageSpace's existing conversation UI.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Agent conversation timeline view" />
            <PR n={2} desc="Memory browser (scoped: context/task/plan/global)" />
            <PR n={3} desc="TurnLog inspector (exact context windows)" />
            <PR n={4} desc="Tool call/result visualization" />
          </ul>
        </Card>

        <Card accent="violet">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--violet)" }}>
              E4.4 Skill &amp; Workflow Management
            </span>
            <Ref tab="Interface" section="Observability" />
          </div>
          <p style={{ fontSize: 12 }}>
            Skill catalog UI for browsing Document/Code skill pages. Workflow
            DAG visualization. Trigger configuration. Within PageSpace's
            existing page editing paradigm.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Skill catalog view (browse/search skill pages)" />
            <PR n={2} desc="Workflow DAG visualization on workflow pages" />
            <PR n={3} desc="Trigger configuration UI on agent pages" />
            <PR n={4} desc="Skill versioning + diff view" />
          </ul>
        </Card>
      </ProjectSection>

      <hr />

      {/* ═══════════ P5: Orchestration ═══════════ */}
      <ProjectSection
        number="P5"
        name="Orchestration"
        color="var(--amber)"
        description="The event system that makes the runtime programmable. Triggers, gates, swarms, schedules — PurePoint's orchestration model running on PageSpace primitives."
        depends="P1 + P2 + P3"
      >
        <Card accent="amber">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--amber)" }}>
              E5.1 Trigger Engine
            </span>
            <Ref tab="Events" section="Trigger Sources" />
          </div>
          <p style={{ fontSize: 12 }}>
            The core event primitive. Code events, agent events, system events
            fire triggers. Each trigger invokes skills, commands, context
            lookups, memory ops, or scoring.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Event bus + trigger entity registration" />
            <PR n={2} desc="Code event sources (file save, commit, PR)" />
            <PR n={3} desc="Agent event sources (spawn, finish, idle)" />
            <PR n={4} desc="System event sources (schedule, status change)" />
            <PR n={5} desc="Action dispatch (trigger → skill/command/context)" />
          </ul>
        </Card>

        <Card accent="amber">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--amber)" }}>
              E5.2 Gates
            </span>
            <Ref tab="Events" section="Action Targets" />
            <Ref tab="Architecture" section="What's New" />
          </div>
          <p style={{ fontSize: 12 }}>
            Validation checkpoints that block state transitions. Shell commands,
            test suites, lint checks. Retry with backoff on failure.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Gate entity + condition evaluation" />
            <PR n={2} desc="Shell command gates (run tests, lint)" />
            <PR n={3} desc="Retry with configurable backoff" />
            <PR n={4} desc="Gate → state machine integration (block commit/push)" />
          </ul>
        </Card>

        <Card accent="amber">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--amber)" }}>
              E5.3 Swarms
            </span>
            <Ref tab="Architecture" section="What's New" />
          </div>
          <p style={{ fontSize: 12 }}>
            Coordinated multi-agent compositions. Roster defines agent defs
            &times; quantity across N branches. Parallel execution with merge
            strategy.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Roster definition (agent configs × quantity)" />
            <PR n={2} desc="Swarm spawning across branches" />
            <PR n={3} desc="Swarm monitoring + completion detection" />
            <PR n={4} desc="Merge strategy (combine outputs from N agents)" />
          </ul>
        </Card>

        <Card accent="amber">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--amber)" }}>
              E5.4 Scheduling
            </span>
            <Ref tab="Decisions" section="Scheduling" />
          </div>
          <p style={{ fontSize: 12 }}>
            Cron-like recurring automation. Hourly, daily, weekly, monthly.
            Fire agents or swarms on cadence.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Schedule entity + cron expression parser" />
            <PR n={2} desc="Scheduler daemon (evaluate + fire)" />
            <PR n={3} desc="Schedule → trigger integration" />
          </ul>
        </Card>
      </ProjectSection>

      <hr />

      {/* ═══════════ P6: Quality Pipeline ═══════════ */}
      <ProjectSection
        number="P6"
        name="Quality Pipeline"
        color="var(--red)"
        description="Structured scoring, independent review, parallel analysis, and meta-review. Quality is measured, not assumed."
        depends="P1 + P3 + P5"
      >
        <Card accent="red">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--red)" }}>
              E6.1 Rubric &amp; Rating System
            </span>
            <Ref tab="Scoring" />
          </div>
          <p style={{ fontSize: 12 }}>
            Plans carry rubrics with weighted dimensions and gate thresholds.
            Independent review agents score each dimension. Verdict routes to
            pass, partial fix, or full retry.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Rubric entity (dimensions, weights, thresholds)" />
            <PR n={2} desc="Rating entity (per-dimension scores + verdict)" />
            <PR n={3} desc="Verdict → state routing (pass/partial/fail)" />
            <PR n={4} desc="Score visualization UI (bar charts + pills)" />
          </ul>
        </Card>

        <Card accent="red">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--red)" }}>
              E6.2 Independent Review Pipeline
            </span>
            <Ref tab="Agent Isolation" />
            <Ref tab="Scoring" />
          </div>
          <p style={{ fontSize: 12 }}>
            Review contexts that see only code diffs + rubric. No access to
            implementation conversation. Triggered by task status or event
            system.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Review context spawning with filtered inputs" />
            <PR n={2} desc="Rubric injection + structured score output" />
            <PR n={3} desc="Review → Rating entity creation" />
            <PR n={4} desc="Targeted fix routing (failed dimensions only)" />
          </ul>
        </Card>

        <Card accent="red">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--red)" }}>
              E6.3 Parallel Analysis
            </span>
            <Ref tab="Parallel Analysis" />
          </div>
          <p style={{ fontSize: 12 }}>
            N independent agents against the same input. Same prompt for
            consensus or varied prompts for specialized review. Synthesis
            agent compares outputs.
          </p>
          <ul style={prList}>
            <PR n={1} desc="ParallelRun entity + N-context spawning" />
            <PR n={2} desc="Same-prompt mode (consensus detection)" />
            <PR n={3} desc="Varied-prompt mode (specialized lenses)" />
            <PR n={4} desc="Synthesis agent + consensus output UI" />
          </ul>
        </Card>

        <Card accent="red">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--red)" }}>
              E6.4 Meta-review &amp; Coherence
            </span>
            <Ref tab="Workflow DAG" />
          </div>
          <p style={{ fontSize: 12 }}>
            Cross-plan coherence check after all tasks complete. Verifies the
            aggregate output hangs together. Produces final Snapshot.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Meta-review context (sees all ratings + mutations)" />
            <PR n={2} desc="Coherence scoring (cross-cutting concerns)" />
            <PR n={3} desc="Snapshot creation on approval" />
          </ul>
        </Card>
      </ProjectSection>

      <hr />

      {/* ═══════════ P7: Skills System ═══════════ */}
      <ProjectSection
        number="P7"
        name="Skills System"
        color="var(--violet)"
        description="Pages become reusable agent capabilities. Skill catalog, runtime discovery, and the visual workflow builder."
        depends="P1 + P3 + P5"
      >
        <Card accent="violet">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--violet)" }}>
              E7.1 Pages as Skills
            </span>
            <Ref tab="Architecture" section="What's New" />
          </div>
          <p style={{ fontSize: 12 }}>
            Doc/Code page + metadata = skill. System prompt, enabled tools,
            context requirements, output schema. Composable via page tree.
            Version-tracked.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Skill metadata schema on page entity" />
            <PR n={2} desc="Skill execution runtime (load page → configure agent)" />
            <PR n={3} desc="Hierarchical composition (nested page skills)" />
            <PR n={4} desc="Skill versioning + rollback" />
          </ul>
        </Card>

        <Card accent="violet">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--violet)" }}>
              E7.2 Skill Catalog &amp; Discovery
            </span>
            <Ref tab="Events" section="Skill Catalog" />
          </div>
          <p style={{ fontSize: 12 }}>
            Registry of named skills. Agents query the catalog at runtime.
            Supervisors discover and select skills based on the task.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Skill registry + catalog API" />
            <PR n={2} desc="Built-in skills (review, fix, test-gen, lint, decompose)" />
            <PR n={3} desc="Runtime skill discovery for supervisor agents" />
            <PR n={4} desc="Catalog UI (browse, search, configure)" />
          </ul>
        </Card>

        <Card accent="violet">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--violet)" }}>
              E7.3 Workflow Builder
            </span>
            <Ref tab="Workflow DAG" />
          </div>
          <p style={{ fontSize: 12 }}>
            Visual editor for the event system. Drag skill nodes. Connect with
            trigger edges. Configure context loading and scoring thresholds.
            No code required.
          </p>
          <ul style={prList}>
            <PR n={1} desc="DAG canvas + node/edge data model" />
            <PR n={2} desc="Skill node type (drag from catalog)" />
            <PR n={3} desc="Trigger edge type (conditions + routing)" />
            <PR n={4} desc="DAG → trigger configuration serialization" />
            <PR n={5} desc="Live execution overlay (active node highlighting)" />
          </ul>
        </Card>
      </ProjectSection>

      <hr />

      {/* ═══════════ P8: Search & Analytics ═══════════ */}
      <ProjectSection
        number="P8"
        name="Search &amp; Analytics"
        color="var(--amber)"
        description="Cross-layer search over every entity. The compounding asset — searchable history of how AI built the codebase."
        depends="P3"
      >
        <Card accent="amber">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--amber)" }}>
              E8.1 Lexical Search
            </span>
            <Ref tab="Search" section="Lexical" />
          </div>
          <p style={{ fontSize: 12 }}>
            Exact-match queries across all entities. "Mutations that touched
            auth middleware." "Turns where token count exceeded 80k."
          </p>
          <ul style={prList}>
            <PR n={1} desc="Entity indexing pipeline" />
            <PR n={2} desc="Query parser + filter expressions" />
            <PR n={3} desc="Search results UI with entity type facets" />
          </ul>
        </Card>

        <Card accent="amber">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--amber)" }}>
              E8.2 Semantic Search
            </span>
            <Ref tab="Search" section="Semantic" />
          </div>
          <p style={{ fontSize: 12 }}>
            Meaning-based queries. "Times agents struggled with async errors."
            "System prompts that led to scope creep." Embeddings over all
            entity content.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Embedding pipeline for entity content" />
            <PR n={2} desc="Vector store + similarity search" />
            <PR n={3} desc="Hybrid ranking (lexical + semantic)" />
            <PR n={4} desc="Natural language query interface" />
          </ul>
        </Card>

        <Card accent="amber">
          <div style={epicHeader}>
            <span style={{ ...epicTitle, color: "var(--amber)" }}>
              E8.3 Cross-layer Analytics
            </span>
            <Ref tab="Search" section="Compounding asset" />
          </div>
          <p style={{ fontSize: 12 }}>
            Agent profiles from accumulated ratings. Smarter decomposition
            from past task patterns. Institutional memory that stays when
            people leave.
          </p>
          <ul style={prList}>
            <PR n={1} desc="Rating aggregation per agent config" />
            <PR n={2} desc="Task pattern analysis (scope/rubric effectiveness)" />
            <PR n={3} desc="Dashboard UI (trends, agent profiles, hotspots)" />
          </ul>
        </Card>
      </ProjectSection>

      <hr />

      {/* ── Summary ── */}
      <div className="sl">Summary</div>
      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="blue">
          <h4>8 projects</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Core Runtime, BRANCH + Containers, Entity State, Orchestration UI,
            Orchestration, Quality Pipeline, Skills, Search.
          </p>
        </Card>
        <Card accent="violet">
          <h4>27 epics</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Each a deliverable milestone with clear scope, dependencies,
            and cross-references to the feature spec on other tabs.
          </p>
        </Card>
        <Card accent="cyan">
          <h4>~100 incremental PRs</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Each 1&ndash;3 files, independently reviewable, ordered by
            dependency. Types before impl. Impl before tests.
          </p>
        </Card>
      </div>
      <div className="g2">
        <Card accent="green">
          <h4>Start here</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            One BRANCH page with one AI_CHAT child agent, running in a
            container with CLI access to PageSpace. Get that solid. Ship it.
            Everything else is N of those with parent pointers, reactive rules,
            and scoring.
          </p>
        </Card>
        <Card accent="amber">
          <h4>What's already live</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            PageSpace primitives (pages, drives, permissions, AI providers, CLI)
            and AIDD methodology are production today. This plan builds
            orchestration and observability on top of that foundation.
          </p>
        </Card>
      </div>
    </div>
  );
}
