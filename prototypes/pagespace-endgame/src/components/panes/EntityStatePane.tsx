import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";

const fieldStyle = {
  fontFamily: "var(--mono)",
  fontSize: 10,
  lineHeight: 1.7,
  color: "var(--mid)",
} as const;

const relColor = "var(--cyan)";

function EntityCard({
  name,
  badge,
  accent,
  fields,
}: {
  name: string;
  badge: string;
  accent: string;
  fields: { name: string; type: string; rel?: boolean }[];
}) {
  return (
    <Card accent={accent} style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <h4 style={{ color: `var(--${accent})`, fontSize: 13, fontWeight: 600 }}>{name}</h4>
        <span style={{ fontSize: 8, fontWeight: 600, color: "var(--dim)", letterSpacing: 0.8, textTransform: "uppercase" as const }}>{badge}</span>
      </div>
      <div style={fieldStyle}>
        {fields.map((f, i) => (
          <div key={i}>
            <span style={{ color: "var(--text)" }}>{f.name}</span>
            {": "}
            <span style={{ color: f.rel ? relColor : "var(--dim)" }}>{f.type}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function EntityStatePane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        Attribution exists.{" "}
        <span className="hl">Traceability doesn&apos;t.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        PageSpace tracks <em>that</em> things happen &mdash; activity logs with
        hash chains, AI usage with cost tracking, page version history. But
        there&apos;s no structured entity graph connecting intent to execution
        to output to quality. You can see who did what. You can&apos;t see why.
      </p>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Activity logs</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Hash-chained audit trail. 30+ operations. AI attribution:
            <code> isAiGenerated</code>, provider, model, conversationId.
            Content snapshots with rollback support. Change grouping for
            atomic operations.
          </p>
        </Card>
        <Card accent="green">
          <h4>AI usage logs</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Per-call: tokens, cost, duration, context window breakdown
            (system/tool/conversation tokens). Truncation tracking. 100+ model
            pricing. Analytics endpoints.
          </p>
        </Card>
        <Card accent="green">
          <h4>Page version history</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            30-day auto-retention, pinnable versions. Tracks content changes
            over time. But versions don&apos;t link to agents, plans, tasks,
            or quality scores.
          </p>
        </Card>
      </div>

      <Card accent="amber" style={{ marginBottom: 12 }}>
        <h4>The missing link</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          We have <code>isAiGenerated = true</code> on activity logs. That&apos;s
          attribution. Traceability is different: Plan &rarr; Task &rarr;
          AgentContext &rarr; TurnLog &rarr; Mutation &rarr; Commit &rarr; PR
          &rarr; Rating. The chain from <em>intent</em> to <em>scored
          output</em> doesn&apos;t exist yet. Every entity needs to link to
          every entity it touches.
        </p>
      </Card>

      <hr />

      {/* ── Entity Spec ── */}
      <div className="sl">End Game</div>
      <h2>
        17 entities.{" "}
        <span className="hl">Every artifact linked.</span>
      </h2>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        The entity state layer is the structured graph that connects intent
        to execution to output to quality. Every entity has a primary key,
        typed fields, and relations to other entities. &ldquo;Why does this
        code exist?&rdquo; becomes a single query traversal.
      </p>

      {/* Intent Layer */}
      <h3 style={{ marginBottom: 12 }}>
        <span style={{ color: "var(--green)" }}>Intent</span> &mdash; why
      </h3>
      <div className="g3" style={{ marginBottom: 20 }}>
        <EntityCard name="Plan" badge="source of truth" accent="green" fields={[
          { name: "id", type: "EntityID" },
          { name: "scope", type: "String" },
          { name: "description", type: "String" },
          { name: "status", type: "PlanStatus" },
          { name: "rubric", type: "→ Rubric", rel: true },
          { name: "tasks", type: "→ [Task]", rel: true },
          { name: "prs", type: "→ [PR]", rel: true },
        ]} />
        <EntityCard name="Task" badge="scoped work unit" accent="green" fields={[
          { name: "id", type: "EntityID" },
          { name: "status", type: "TaskStatus" },
          { name: "plan", type: "→ Plan", rel: true },
          { name: "contexts", type: "→ [AgentCtx]", rel: true },
          { name: "mutations", type: "→ [Mutation]", rel: true },
          { name: "commits", type: "→ [Commit]", rel: true },
          { name: "ratings", type: "→ [Rating]", rel: true },
        ]} />
        <EntityCard name="Rubric" badge="scoring criteria" accent="green" fields={[
          { name: "id", type: "EntityID" },
          { name: "plan", type: "→ Plan", rel: true },
          { name: "dimensions", type: "[Dimension]" },
          { name: "threshold", type: "f32" },
        ]} />
      </div>

      {/* Execution Layer */}
      <h3 style={{ marginBottom: 12 }}>
        <span style={{ color: "var(--blue)" }}>Execution</span> &mdash; how
      </h3>
      <div className="g2" style={{ marginBottom: 8 }}>
        <EntityCard name="AgentContext" badge="= chat history" accent="blue" fields={[
          { name: "id", type: "EntityID" },
          { name: "type", type: "ContextType" },
          { name: "messages", type: "→ [Message]", rel: true },
          { name: "sandbox_id", type: "String" },
          { name: "status", type: "AgentStatus" },
          { name: "parent", type: "→ AgentCtx?", rel: true },
          { name: "task", type: "→ Task", rel: true },
          { name: "mutations", type: "→ [Mutation]", rel: true },
          { name: "memory", type: "→ [Memory]", rel: true },
        ]} />
        <EntityCard name="ChatMessage" badge="conversation log" accent="blue" fields={[
          { name: "id", type: "EntityID" },
          { name: "context", type: "→ AgentCtx", rel: true },
          { name: "role", type: "Role" },
          { name: "content", type: "String" },
          { name: "tool_calls", type: "[ToolCall]?" },
          { name: "turn_log", type: "→ TurnLog", rel: true },
          { name: "mutations", type: "→ [Mutation]?", rel: true },
          { name: "timestamp", type: "DateTime" },
        ]} />
      </div>
      <div className="g2" style={{ marginBottom: 20 }}>
        <EntityCard name="TurnLog" badge="exact LLM context" accent="blue" fields={[
          { name: "id", type: "EntityID" },
          { name: "message", type: "→ Message", rel: true },
          { name: "system_prompt", type: "String" },
          { name: "messages_sent", type: "[Message]" },
          { name: "model", type: "String" },
          { name: "provider", type: "String" },
          { name: "temperature", type: "f32" },
          { name: "token_count", type: "TokenUsage" },
          { name: "latency_ms", type: "u64" },
          { name: "response_raw", type: "String" },
          { name: "timestamp", type: "DateTime" },
        ]} />
        <EntityCard name="AgentMemory" badge="persistent knowledge" accent="blue" fields={[
          { name: "id", type: "EntityID" },
          { name: "context", type: "→ AgentCtx", rel: true },
          { name: "scope", type: "MemoryScope" },
          { name: "key", type: "String" },
          { name: "value", type: "String" },
          { name: "source_turn", type: "→ TurnLog?", rel: true },
          { name: "created_at", type: "DateTime" },
          { name: "expires_at", type: "DateTime?" },
        ]} />
      </div>

      {/* Output Layer */}
      <h3 style={{ marginBottom: 12 }}>
        <span style={{ color: "var(--violet)" }}>Output</span> &mdash; what
      </h3>
      <div className="g3" style={{ marginBottom: 8 }}>
        <EntityCard name="Mutation" badge="append-only" accent="violet" fields={[
          { name: "id", type: "EntityID" },
          { name: "file", type: "→ File", rel: true },
          { name: "diff", type: "String" },
          { name: "authored_by", type: "→ AgentCtx", rel: true },
          { name: "plan_node", type: "→ Plan", rel: true },
          { name: "commit", type: "→ Commit?", rel: true },
          { name: "rating", type: "→ Rating?", rel: true },
          { name: "timestamp", type: "DateTime" },
        ]} />
        <EntityCard name="GitCommit" badge="captured event" accent="violet" fields={[
          { name: "id", type: "EntityID" },
          { name: "sha", type: "String" },
          { name: "message", type: "String" },
          { name: "mutations", type: "→ [Mutation]", rel: true },
          { name: "authored_by", type: "→ AgentCtx", rel: true },
          { name: "task", type: "→ Task", rel: true },
          { name: "pr", type: "→ PR?", rel: true },
        ]} />
        <EntityCard name="PR" badge="scoped changeset" accent="violet" fields={[
          { name: "id", type: "EntityID" },
          { name: "status", type: "PRStatus" },
          { name: "plan_node", type: "→ Plan", rel: true },
          { name: "commits", type: "→ [Commit]", rel: true },
          { name: "review", type: "→ AgentCtx", rel: true },
          { name: "rating", type: "→ Rating", rel: true },
          { name: "base", type: "→ Snapshot", rel: true },
        ]} />
      </div>
      <div className="g3" style={{ marginBottom: 20 }}>
        <EntityCard name="File" badge="code artifact" accent="violet" fields={[
          { name: "id", type: "EntityID" },
          { name: "path", type: "String" },
          { name: "language", type: "String" },
          { name: "mutations", type: "→ [Mutation]", rel: true },
        ]} />
        <EntityCard name="Snapshot" badge="point-in-time" accent="violet" fields={[
          { name: "id", type: "EntityID" },
          { name: "name", type: "String" },
          { name: "entities", type: "→ [State]", rel: true },
          { name: "plan", type: "→ Plan", rel: true },
        ]} />
        <EntityCard name="Rating" badge="scored output" accent="amber" fields={[
          { name: "id", type: "EntityID" },
          { name: "target", type: "→ Mut|PR", rel: true },
          { name: "rubric", type: "→ Rubric", rel: true },
          { name: "produced_by", type: "→ AgentCtx", rel: true },
          { name: "scores", type: "Map<Dim,f32>" },
          { name: "verdict", type: "Verdict" },
        ]} />
      </div>

      {/* Orchestration Layer */}
      <h3 style={{ marginBottom: 12 }}>
        <span style={{ color: "var(--cyan)" }}>Orchestration</span> &mdash; coordination
      </h3>
      <div className="g3" style={{ marginBottom: 12 }}>
        <EntityCard name="Trigger" badge="event → actions" accent="cyan" fields={[
          { name: "id", type: "EntityID" },
          { name: "source", type: "TriggerSource" },
          { name: "condition", type: "Expression" },
          { name: "actions", type: "[Action]" },
          { name: "enabled", type: "bool" },
          { name: "priority", type: "u32" },
        ]} />
        <EntityCard name="Skill" badge="reusable capability" accent="cyan" fields={[
          { name: "id", type: "EntityID" },
          { name: "name", type: "String" },
          { name: "system_prompt", type: "String" },
          { name: "tools", type: "[ToolDef]" },
          { name: "context_reqs", type: "[ContextReq]" },
          { name: "output_schema", type: "Schema?" },
          { name: "model_pref", type: "String?" },
        ]} />
        <EntityCard name="ParallelRun" badge="ensemble analysis" accent="cyan" fields={[
          { name: "id", type: "EntityID" },
          { name: "mode", type: "ParallelMode" },
          { name: "contexts", type: "→ [AgentCtx]", rel: true },
          { name: "input", type: "→ Mut|PR|Plan", rel: true },
          { name: "skills", type: "→ [Skill]", rel: true },
          { name: "synthesis", type: "→ AgentCtx", rel: true },
          { name: "consensus", type: "ConsensusMap" },
        ]} />
      </div>

      <hr />

      {/* ── Traceability ── */}
      <div className="sl">Traceability</div>
      <h2>
        Every entity links to{" "}
        <span className="hl">every entity it touches.</span>
      </h2>

      <ArchDiagram>
        <ArchRow label="Intent" labelSub="why" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Plan"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Decomposes into Tasks.<br>Defines Rubric (scoring criteria).<br>Scopes PRs."
          />
          <ArchNode
            title="Task"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Spawns AgentContext (= chat history).<br>Inherits Rubric from Plan.<br>Collects Mutations, Commits, Ratings."
          />
        </ArchRow>

        <ArchConnector text="tasks spawn agent contexts" />

        <ArchRow label="Execution" labelSub="how" style={{ marginBottom: 8 }}>
          <ArchNode
            title="AgentContext"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            detail="Chat history = execution record.<br>Produces Mutations. Parents sub-agents.<br>Scoped memory (context/task/plan/global)."
          />
          <ArchNode
            title="TurnLog"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            detail="Exact LLM context per call.<br>System prompt, messages, model, tokens.<br>May create AgentMemory entries."
          />
        </ArchRow>

        <ArchConnector text="execution produces code artifacts" />

        <ArchRow label="Output" labelSub="what" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Mutation"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            detail="Append-only. File + diff.<br>Links to plan_node (why it exists).<br>Captured as GitCommit."
          />
          <ArchNode
            title="Commit → PR"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            detail="Commits grouped into PR scoped by Plan.<br>PR reviewed by isolated ReviewContext.<br>Review produces Rating."
          />
        </ArchRow>

        <ArchConnector text="output gets scored against rubric" />

        <ArchRow label="Quality" labelSub="how good">
          <ArchNode
            title="Rating"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            detail="Per-dimension scores against Rubric.<br>Verdict: pass / partial / fail.<br>Triggers Task transition → advances Plan."
          />
          <ArchNode
            title="MetaReview"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            detail="All PRs coherence check.<br>Cross-cutting concerns.<br>Approves Snapshot (point-in-time)."
          />
        </ArchRow>
      </ArchDiagram>

      <h3 style={{ marginBottom: 12 }}>Query patterns</h3>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="blue">
          <h4 style={{ color: "var(--blue)" }}>&ldquo;Why does this code exist?&rdquo;</h4>
          <pre style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--mid)", margin: "8px 0 0", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
{`file.mutations.map(m => m.plan_node)
  // → the plan that requested it
file.mutations.map(m => m.authored_by)
  // → the agent context (chat)
file.mutations.map(m => m.rating)
  // → the quality score
file.mutations.map(m => m.commit.pr)
  // → the PR it shipped in

// What did the agent see when it wrote this?
mutation.message.turn_log.messages_sent
  // → exact context window for that decision`}
          </pre>
        </Card>
        <Card accent="amber">
          <h4 style={{ color: "var(--amber)" }}>&ldquo;What did this plan produce?&rdquo;</h4>
          <pre style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--mid)", margin: "8px 0 0", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
{`plan.tasks.flatMap(t => t.contexts)
  // → all agent conversations
plan.tasks.flatMap(t => t.commits)
  // → all commits across all tasks
plan.prs.map(pr => pr.rating)
  // → quality scores for every PR
plan.prs.map(pr => pr.review.messages)
  // → full review reasoning`}
          </pre>
        </Card>
      </div>

      <hr />

      {/* ── Storage ── */}
      <div className="sl">Open Design Question</div>
      <h2>
        In-container state:{" "}
        <span className="hl">where do entities live?</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Agents in swarms make rapid mutations, tool calls, and state
        transitions &mdash; potentially thousands of writes per second during
        peak execution. PostgreSQL over the network may be too slow for this
        hot path. The storage layer is an open design question.
      </p>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>PostgreSQL (existing stack)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Consistent with existing infrastructure (6 monitoring tables, 89
            total). Drizzle ORM, existing indexes, retention policies carry
            forward. Joins across all entity types natively.
            <strong> Risk:</strong> network latency during agent swarm
            execution. May outgrow single instance at peak write volume.
            Could work with partitioning.
          </p>
        </Card>
        <Card accent="blue">
          <h4>SQLite via Turso (per container)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Local database per container &mdash; zero network latency during
            execution. Turso sync for cross-container visibility. Familiar
            SQL. Container dies &rarr; final sync &rarr; local state gone.
            <strong> Risk:</strong> sync complexity, conflict resolution
            between containers, query limitations during execution.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="violet">
          <h4>ECS (@adobe/data)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Entity Component System with reactive change tracking.
            Schema-driven typed arrays. Purpose-built for high-frequency
            state mutations. Components are data; systems are logic.
            <strong> Risk:</strong> niche dependency, unfamiliar paradigm,
            narrow community. Needs evaluation against our access patterns
            (heavily relational, not archetype-based).
          </p>
        </Card>
        <Card accent="red">
          <h4>Redis (shared state)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Already in the stack. Good for pub/sub and simple state.
            Shared across containers by default.
            <strong> Risk:</strong> bad for complex entity queries.
            No relations, no joins, no schema enforcement. Works for
            coordination signals, not as a primary entity store.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)", marginBottom: 12 }}>
        <h4 style={{ color: "var(--dim)" }}>Decision criteria</h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          Start with PostgreSQL &mdash; it&apos;s the path of least surprise
          and all existing observability infrastructure is already there. The
          entity schema should be storage-agnostic: define entities in
          Drizzle, swap the backing store later if measured write throughput
          demands it. Turso is the most likely upgrade path (local writes
          during execution, sync to Postgres on completion). ECS is a
          wildcard worth evaluating but not committing to early.
        </p>
      </Card>

      <hr />

      {/* ── Open Questions ── */}
      <h3 style={{ marginBottom: 12 }}>Related open questions</h3>

      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--red)"
          name="Multiplayer on git"
          description="Multiple agents editing the same codebase across branches. Humans collaborating with agents in real time. Does the state layer need CRDT-like conflict resolution, or can git's merge model handle concurrent agent edits?"
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Persistence at agent scale"
          description="Every agent loop iteration, tool call, and mutation must be captured (TurnLogs, AgentMemory, Mutations). Write volume may outgrow a single Postgres instance. Tiered storage? Event sourcing? Separate write-optimized store?"
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="BRANCH page depth"
          description="A BRANCH page backed by a container is fundamentally different from other page types. Can you nest them (branch off a branch)? Does the file tree inside surface as child pages? Or is the container fully opaque?"
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>
    </div>
  );
}
