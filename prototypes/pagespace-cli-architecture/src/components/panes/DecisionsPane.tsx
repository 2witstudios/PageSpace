import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import {
  DataTable,
  DecisionRow,
  SectionHeader,
} from "../ui/DataTable";

const locked = (
  <span
    style={{
      color: "var(--green)",
      fontFamily: "var(--mono)",
      fontSize: 11,
    }}
  >
    &#10003; locked
  </span>
);

const openDesign = (
  <span
    style={{
      color: "var(--amber)",
      fontFamily: "var(--mono)",
      fontSize: 11,
    }}
  >
    &nearr; design
  </span>
);

const openV11 = (
  <span
    style={{
      color: "var(--amber)",
      fontFamily: "var(--mono)",
      fontSize: 11,
    }}
  >
    &nearr; v1.1
  </span>
);

export function DecisionsPane() {
  return (
    <div className="pane">
      <div className="sl">Decision Log</div>
      <h2>
        What's decided. <span className="hl">What's still open.</span>
      </h2>
      <p style={{ marginBottom: 24 }}>
        Core architecture converges PageSpace primitives with PurePoint
        orchestration. Implementation status varies.
      </p>

      <Card
        style={{ overflow: "auto", marginBottom: 20, padding: 0 }}
      >
        <DataTable
          headers={["Area", "Decision", "Rationale", "", "Impl"]}
        >
          <SectionHeader
            text="Orchestration — from PurePoint"
            color="var(--violet)"
          />
          <DecisionRow
            area="Agent Runtime"
            decision="Agent loop (replaces Vercel AI SDK)"
            rationale="Real loops: plan → execute → evaluate → loop. Sub-agents as child pages. Suspend/resume. Bounded by gates, not single-turn tool calls."
            status={locked}
            impl={<StatusBadge variant="planned" />}
          />
          <DecisionRow
            area="Triggers"
            decision="Event-driven automation"
            rationale="agent_idle, pre_commit, pre_push, schedule, page_change. From PurePoint's trigger model with gate sequences and retry logic."
            status={locked}
            impl={<StatusBadge variant="planned" />}
          />
          <DecisionRow
            area="Gates"
            decision="Validation before state transitions"
            rationale="Shell commands, test suites, lint checks that block commits/pushes/advances. Retry with backoff. From PurePoint's gate model."
            status={locked}
            impl={<StatusBadge variant="planned" />}
          />
          <DecisionRow
            area="Swarms"
            decision="Coordinated multi-agent"
            rationale="Roster definitions: agent defs × quantity across N branches. Parallel execution with merge. From PurePoint's swarm model."
            status={locked}
            impl={<StatusBadge variant="planned" />}
          />
          <DecisionRow
            area="Scheduling"
            decision="Recurring automation"
            rationale="Cron-like: hourly, daily, weekdays, weekly, monthly. Fire agents or swarms on cadence. From PurePoint's scheduler."
            status={locked}
            impl={<StatusBadge variant="planned" />}
          />

          <SectionHeader
            text="Primitives — from PageSpace"
            color="var(--green)"
          />
          <DecisionRow
            area="Data Model"
            decision="Pages as universal primitive"
            rationale="Everything is a page. Doc/Code pages become skills. AI Chat pages become running agents. Drives = project scope. Tree = context hierarchy."
            status={locked}
            impl={<StatusBadge variant="live" />}
          />
          <DecisionRow
            area="Persistence"
            decision="PostgreSQL + version history"
            rationale="From PageSpace. Every page versioned (30 days auto, pin for indefinite). Audit trails. Content-addressed storage."
            status={locked}
            impl={<StatusBadge variant="live" />}
          />
          <DecisionRow
            area="Auth"
            decision="Shared with PageSpace"
            rationale="Opaque session tokens (SHA-256), OAuth, passkeys, CLI tokens with browser OAuth and drive scoping. Zero-trust model."
            status={locked}
            impl={<StatusBadge variant="live" />}
          />
          <DecisionRow
            area="AI Providers"
            decision="Multi-provider (100+ models)"
            rationale="From PageSpace. Anthropic, OpenAI, Google, xAI, OpenRouter, Ollama. Per-agent model config. Switch without code changes."
            status={locked}
            impl={<StatusBadge variant="live" />}
          />
          <DecisionRow
            area="External API"
            decision="Pagespace CLI"
            rationale="CLI installed in containers, used by agents to access PageSpace from the shell. Token auth for agents, browser OAuth for humans. Agents in shells are more powerful — shell power + PageSpace access."
            status={locked}
            impl={<StatusBadge variant="live" />}
          />

          <SectionHeader
            text="New — built for Pagespace CLI"
            color="var(--blue)"
          />
          <DecisionRow
            area="Skills"
            decision="Pages as skills"
            rationale="Doc/Code page + metadata (system prompt, enabled tools, context reqs) = reusable skill. Composable via page tree. Version-tracked."
            status={locked}
            impl={<StatusBadge variant="planned" />}
          />
          <DecisionRow
            area="Execution"
            decision="BRANCH page type"
            rationale="New page type backed by cloud container. Create BRANCH page → container spins up with branch checked out. AI_CHAT children run agents inside. Same page tree, same permissions."
            status={locked}
            impl={<StatusBadge variant="planned" />}
          />
          <DecisionRow
            area="UI Model"
            decision="PageSpace is the interface"
            rationale="No separate workspace UI. Orchestration features (agent status, container health, skill browsing) surface within PageSpace's existing web UI. The page tree IS the workspace."
            status={locked}
            impl={<StatusBadge variant="planned" />}
          />
          <DecisionRow
            area="State"
            decision="In-container state layer"
            rationale="Agents need fast local state during execution. Three candidates: ECS (@adobe/data) for reactive change tracking, SQLite via Turso for local+sync, or Redis for shared state. See open questions."
            status={openDesign}
            impl={<StatusBadge variant="planned" />}
          />
          <DecisionRow
            area="API Format"
            decision="Jiron"
            rationale="Hypermedia media type. Token-efficient for LLM agents. Self-documenting progressive discovery."
            status={locked}
            impl={
              <StatusBadge variant="spec" />
            }
          />
          <DecisionRow
            area="Methodology"
            decision="AIDD"
            rationale="Prompt programs for TDD, review, discovery. The workflow being automated."
            status={locked}
            impl={<StatusBadge variant="live" />}
          />
          <DecisionRow
            area="Reviews"
            decision="Strict context isolation"
            rationale="Reviewers never see implementation reasoning. Methodology today, enforced by runtime later."
            status={locked}
            impl={<StatusBadge variant="methodology" />}
          />
          <DecisionRow
            area="Scoping"
            decision="Decomposition agent"
            rationale="Key risk. Scope boundaries determine everything downstream."
            status={openDesign}
            impl={<StatusBadge variant="planned" />}
          />
          <DecisionRow
            area="Intervention"
            decision="Pause, inject, kill"
            rationale="Core UX question. What can you do watching a live agent?"
            status={openDesign}
            impl={<StatusBadge variant="planned" />}
          />
          <DecisionRow
            area="Conflicts"
            decision="Swarm conflict protocol"
            rationale="How do parallel agents detect and resolve conflicting edits? Depends on state layer choice."
            status={openDesign}
            impl={<StatusBadge variant="planned" />}
          />
          <DecisionRow
            area="Search"
            decision="Lexical + semantic"
            rationale="Cross-layer analytics over all entities."
            status={openV11}
            impl={<StatusBadge variant="planned" />}
          />
        </DataTable>
      </Card>

      <hr />
      <div className="sl">Open Architecture Questions</div>
      <h2>
        Even the broader PageSpace architecture is{" "}
        <span className="hl">in question.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The decisions above assume PageSpace's existing PostgreSQL + Drizzle
        stack. But agent workloads have fundamentally different access patterns
        than CMS workloads. These questions may reshape the platform itself.
      </p>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="red">
          <h4>In-container state: ECS vs SQLite/Turso vs Redis</h4>
          <p style={{ marginTop: 6, fontSize: 12, lineHeight: 1.8 }}>
            Agents in swarms make rapid mutations, tool calls, and state
            transitions — potentially thousands of writes per second during
            peak execution. PostgreSQL over the network is too slow for this
            hot path.
          </p>
          <p style={{ marginTop: 8, fontSize: 12, lineHeight: 1.8 }}>
            <strong style={{ color: "var(--text)" }}>ECS (@adobe/data)</strong>
            {" "}&mdash; reactive change tracking, schema-driven typed arrays.
            Purpose-built for high-frequency state. But niche, another paradigm.
            <br />
            <strong style={{ color: "var(--text)" }}>
              SQLite via Turso
            </strong>
            {" "}&mdash; local database per container, zero network latency
            during execution. Turso sync for cross-container visibility. Familiar
            SQL. Container dies → final sync → local gone.
            <br />
            <strong style={{ color: "var(--text)" }}>Redis</strong> &mdash;
            already in the stack. Good for pub/sub and simple state. Bad for
            complex entity queries. Shared across containers by default.
          </p>
        </Card>
        <Card accent="red">
          <h4>Multiplayer on git: what does this actually look like?</h4>
          <p style={{ marginTop: 6, fontSize: 12, lineHeight: 1.8 }}>
            Multiple agents editing the same codebase across branches. Humans
            collaborating with agents in real time. This is "Google Docs for
            code" territory but on top of git, not instead of it.
          </p>
          <p style={{ marginTop: 8, fontSize: 12, lineHeight: 1.8 }}>
            Does the state layer need CRDT-like conflict resolution? Can git's
            merge model handle concurrent agent edits, or do we need a layer
            above git that resolves before commit? This choice is entangled
            with the state layer decision.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="amber">
          <h4>Does PageSpace need a persistence rethink?</h4>
          <p style={{ marginTop: 6, fontSize: 12, lineHeight: 1.8 }}>
            PageSpace was built as a CMS — PostgreSQL is right for pages,
            drives, permissions, conversations. But if every agent loop
            iteration, every tool call, every mutation needs to be captured
            (TurnLogs, AgentMemory, Mutations), the write volume may outgrow
            a single Postgres instance. Do we need: tiered storage? Event
            sourcing? A separate write-optimized store for agent telemetry?
            Turso as the primary database replacing Postgres?
          </p>
        </Card>
        <Card accent="amber">
          <h4>How deep does the BRANCH page abstraction go?</h4>
          <p style={{ marginTop: 6, fontSize: 12, lineHeight: 1.8 }}>
            A BRANCH page backed by a container is a page that behaves
            fundamentally different from other page types. How far does this
            go? Can you nest BRANCH pages (branch off a branch)? Does the
            file tree inside the container surface as child pages? Or is the
            container fully opaque — you only interact with it through the
            CLI and agent conversations?
          </p>
        </Card>
      </div>

      <hr />
      <div className="g2">
        <Card accent="green">
          <h4>Start here</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            One BRANCH page with one AI_CHAT child agent, running in a
            container with CLI access to PageSpace. Get that solid. Everything
            else is N of those with parent pointers, reactive rules, and scoring.
          </p>
        </Card>
        <Card accent="amber">
          <h4>Hard problems</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            In-container state layer. Multiplayer conflict model. Task scoping
            granularity. Intervention UX. BRANCH page depth. Persistence at
            agent-scale write volume. These shape everything downstream.
          </p>
        </Card>
      </div>
    </div>
  );
}
