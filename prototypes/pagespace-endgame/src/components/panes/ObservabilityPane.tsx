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

export function ObservabilityPane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        Deep audit infrastructure.{" "}
        <span className="hl">Agent reasoning is the gap.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        PageSpace has production-grade observability: tamper-evident hash chains
        on both security events and activity logs, anomaly detection, SIEM
        integration, structured logging across 6 tables, and granular AI cost
        tracking with context window metrics. What&apos;s missing is the
        agent-level reasoning layer &mdash; full prompt capture and decision
        traceability.
      </p>

      <h3 style={{ marginBottom: 12 }}>Tamper-evident audit chains</h3>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Security audit log</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            SHA-256 hash chain with fork prevention (
            <code>pg_advisory_xact_lock</code> serialization). 70+ event
            types across auth, authorization, data access, admin, and
            security categories. PII excluded from hash for GDPR-safe
            anonymization. Risk scoring + anomaly flags per entry.
            8 indexes for forensic queries. 365-day retention.
          </p>
        </Card>
        <Card accent="green">
          <h4>Activity log hash chain</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Separate hash chain on <code>activityLogs</code>. Every CRUD
            operation, permission change, auth event, and AI-generated action.
            AI attribution: <code>isAiGenerated</code>,{" "}
            <code>aiProvider</code>, <code>aiModel</code>,{" "}
            <code>aiConversationId</code>. Content snapshots + rollback
            support with change grouping.
          </p>
        </Card>
      </div>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Chain verification</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Cron job recomputes hashes and verifies chain links. Modes: full
            (complete re-verify), quick (structural check), stats, single-entry.
            On chain break: pluggable <code>ChainAlertHandler</code> fires
            via <code>verifyAndAlert()</code> with structured logging.
            Periodic verification scheduler with overlap guard. Admin API
            at <code>/api/admin/audit-logs/integrity</code>.
          </p>
        </Card>
        <Card accent="green">
          <h4>Anomaly detection</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Four detection types: impossible travel (weight 0.4), new user
            agent (0.2), high frequency (0.3), known bad IP (0.5). Risk
            scores feed into the security audit log. Brute force detection
            logged with riskScore=0.8.
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>AI usage tracking</h3>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Per-call metrics</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Provider, model, input/output/total tokens, cost (USD), duration,
            streaming duration. Context window breakdown:
            <code> systemPromptTokens</code>, <code>toolDefinitionTokens</code>,
            <code> conversationTokens</code>, <code>contextSize</code>,
            <code> messageCount</code>. Truncation tracking:
            <code> wasTruncated</code> flag + strategy.
          </p>
        </Card>
        <Card accent="green">
          <h4>Analytics &amp; cost intelligence</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Aggregated billing per user/page. 100+ model pricing table.
            Token efficiency metrics (cost per 1K tokens by model).
            Popular AI features ranking. Error pattern detection (rate limit,
            timeout, token limit, context exceeded). 6 metric endpoints at
            <code> /api/monitoring/[metric]</code>.
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>Infrastructure logging</h3>
      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Structured system logs</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            6 levels (trace&ndash;fatal), categorized (auth, api, ai,
            database). Batched DB writes (100 entries, 5s flush). Full
            request context, memory/duration metrics.
            10 indexes.
          </p>
        </Card>
        <Card accent="green">
          <h4>API metrics</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Every request: endpoint, method, status, duration, request/response
            size, cache hit/key. User context + session. 90-day retention.
            6 indexes for filtering.
          </p>
        </Card>
        <Card accent="green">
          <h4>Error tracking</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Error name, message, stack, file/line/column. Resolution
            workflow: resolved flag, timestamp, who, notes. Pattern detection
            groups errors by type. 5 indexes.
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>SIEM integration (connected)</h3>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Webhook delivery</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            HMAC-SHA256 signed payloads, batched delivery (up to 1000),
            exponential backoff with jitter (capped 60s), SSRF protection.
            Wired into the processor via cursor-based pg-boss worker (#873).
            Polls <code>activity_logs</code> every 30s and delivers to
            configured SIEM endpoint. Health status exposed at{" "}
            <code>/health</code>.
          </p>
        </Card>
        <Card accent="green">
          <h4>Syslog (RFC 5424)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            TCP and UDP protocols. Structured data elements, configurable
            facility, octet-counting framing. Available as an alternative
            delivery target alongside webhook. Configured via{" "}
            <code>AUDIT_SIEM_TYPE</code> env var.
          </p>
        </Card>
      </div>

      <Card accent="amber" style={{ marginBottom: 12 }}>
        <h4>The prompt gap</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          Prompt and completion fields exist in the schema but are
          <strong> never populated</strong> &mdash; by explicit design for
          PII defense-in-depth. An anonymization job NULLs any content past
          the retention cutoff. You can see <em>that</em> an agent made a
          decision and <em>what it cost</em>, but not <em>what it saw</em>{" "}
          or <em>why it chose that action</em>.
        </p>
      </Card>

      <hr />

      {/* ── Gaps ── */}
      <div className="sl">Gaps</div>
      <h2>
        Can&apos;t answer:{" "}
        <span className="hl">why did the agent do that?</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The platform tracks cost, performance, security events, and user
        actions with cryptographic integrity. But agent reasoning &mdash;
        the chain from intent to decision to output &mdash; is a black box.
      </p>

      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--red)"
          name="No full TurnLog"
          description="Prompts not stored (PII design). Can't reproduce an agent's decision. Can't replay with the same inputs. Can't audit what context it actually saw."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No system prompt capture"
          description="The assembled system prompt (base + drive prompt + agent awareness + page tree) isn't recorded per call. Can't see exactly what the agent was instructed to do."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No reasoning capture"
          description="For reasoning models (Claude thinking, o1, o3), extended thinking isn't preserved. The most valuable debugging artifact — the chain of thought — is lost."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No entity state layer"
          description="No Plan, Task, Mutation, Rating entities connecting intent to code to review. Changes happen but there's no structured traceability chain."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="amber">
          <h4>Tool calls: tracked but shallow</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Tool calls ARE logged via <code>trackAIToolUsage()</code> with
            name, args, result, and duration in AI usage metadata. But
            they&apos;re stored as JSONB blobs &mdash; not a first-class
            entity with its own table, indexes, or queryability. Can&apos;t
            efficiently query &ldquo;show me every read_page call in this
            drive.&rdquo;
          </p>
        </Card>
        <Card accent="amber">
          <h4>AI attribution exists, entity chain doesn&apos;t</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Activity logs mark <code>isAiGenerated</code> + provider/model
            /conversationId. That&apos;s attribution. But there&apos;s no
            structured chain from plan &rarr; task &rarr; agent context
            &rarr; mutation &rarr; rating. The <em>why</em> behind each
            change is missing.
          </p>
        </Card>
        <Card accent="amber">
          <h4>No automated alerting pipeline</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Webhook alerting exists for audit chain failure. But no
            threshold-based alerts (error rate spikes, cost anomalies, agent
            failure patterns). SIEM delivers logs but
            doesn&apos;t trigger on conditions.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── Competitive ── */}
      <div className="sl">Landscape</div>
      <h2>
        AI observability is a{" "}
        <span className="hl">crowded category now.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Dedicated AI observability platforms have matured rapidly. The
        question isn&apos;t whether to build tracing &mdash; it&apos;s
        whether PageSpace&apos;s native position (same DB, same auth, same
        permissions) creates an advantage external tools can&apos;t match.
      </p>

      <FeatureRow columns={3} style={{ marginBottom: 12 }}>
        <Feature
          nameColor="var(--cyan)"
          name="Langfuse"
          description="Open-source, 19K+ GitHub stars. Self-hosted option. Full tracing, prompt management, evaluations, datasets. 50K free events/month. The community standard."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Arize Phoenix"
          description="Industry standard for agentic AI. Multi-step agent traces, reasoning breakdown detection, tool failure identification. Vendor agnostic. Open-source self-hosted option."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Helicone"
          description="Proxy-based, 2-minute setup. Zero instrumentation overhead. Built-in caching for cost savings. $25/month flat. Best for teams where cost is the primary concern."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="blue">
          <h4>What they all offer now</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Multi-step agent tracing. Automated evaluation with LLM-as-judge.
            Token/cost attribution. Prompt versioning + A/B testing.
            Production alerting + drift detection. OpenTelemetry support.
            The bar has moved from &ldquo;log LLM calls&rdquo; to
            &ldquo;integrated debug + evaluate + remediate.&rdquo;
          </p>
        </Card>
        <Card accent="green">
          <h4>PageSpace&apos;s native advantage</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            External tools observe from outside. PageSpace observes from
            inside &mdash; same database, same permissions, same page tree.
            Agent actions, user actions, and audit events are already in the
            same system. The entity state layer connects intent to output
            natively. No integration gap.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        Full traceability.{" "}
        <span className="hl">Every decision reproducible.</span>
      </h2>
      <p style={{ marginBottom: 16, maxWidth: 720 }}>
        Build on the existing audit infrastructure. Add the agent reasoning
        layer on top. The hash chains, SIEM, anomaly detection, and
        cost tracking stay &mdash; TurnLog and entity state fill the gap
        between &ldquo;what happened&rdquo; and &ldquo;why.&rdquo;
      </p>

      <h3 style={{ marginBottom: 12 }}>TurnLog &mdash; full context capture</h3>
      <div className="g2" style={{ marginBottom: 20 }}>
        <Card accent="cyan">
          <h4>What gets recorded per LLM call</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Exact system prompt sent. Full message array (every message the
            agent saw). Model, provider, temperature. Token counts, latency.
            Raw response including tool calls. Tool schemas that were
            available. Reasoning/thinking content if applicable. Opt-in,
            with PII controls and retention policies carried forward from
            existing infrastructure.
          </p>
        </Card>
        <Card accent="cyan">
          <h4>What this enables</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            <strong>Reproducibility:</strong> replay any decision with the
            same inputs. <strong>Auditing:</strong> prove what the agent
            saw when it made a choice. <strong>Debugging:</strong> compare
            context windows between successful and failed attempts.
            <strong> Learning:</strong> which context patterns produce
            better outcomes.
          </p>
        </Card>
      </div>

      {/* ── Entity State Layer ── */}
      <h3 style={{ marginBottom: 12 }}>Entity state &mdash; 17 entities, every artifact linked</h3>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The entity state layer is the structured graph that connects intent
        to execution to output to quality. &ldquo;Why does this code
        exist?&rdquo; becomes a single query traversal. Extends the existing
        activity log + hash chain + AI attribution into a full entity graph.
      </p>

      {/* Intent Layer */}
      <h4 style={{ marginBottom: 8, color: "var(--green)" }}>Intent &mdash; why</h4>
      <div className="g3" style={{ marginBottom: 16 }}>
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
      <h4 style={{ marginBottom: 8, color: "var(--blue)" }}>Execution &mdash; how</h4>
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
      <div className="g2" style={{ marginBottom: 16 }}>
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
      <h4 style={{ marginBottom: 8, color: "var(--violet)" }}>Output &mdash; what</h4>
      <div className="g3" style={{ marginBottom: 8 }}>
        <EntityCard name="Mutation" badge="append-only" accent="violet" fields={[
          { name: "id", type: "EntityID" },
          { name: "file", type: "→ File", rel: true },
          { name: "diff", type: "String" },
          { name: "authored_by", type: "→ AgentCtx", rel: true },
          { name: "plan_node", type: "→ Plan", rel: true },
          { name: "commit", type: "→ Commit?", rel: true },
          { name: "rating", type: "→ Rating?", rel: true },
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
      <div className="g3" style={{ marginBottom: 16 }}>
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
      <h4 style={{ marginBottom: 8, color: "var(--cyan)" }}>Orchestration &mdash; coordination</h4>
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
      <h3 style={{ marginBottom: 12 }}>Traceability graph</h3>

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
      <h3 style={{ marginBottom: 12 }}>Open question: storage layer for entity state</h3>
      <p style={{ marginBottom: 16, maxWidth: 720 }}>
        Agents in swarms make rapid mutations, tool calls, and state
        transitions &mdash; potentially thousands of writes per second during
        peak execution. PostgreSQL over the network may be too slow for this
        hot path.
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
          </p>
        </Card>
        <Card accent="blue">
          <h4>SQLite via Turso (per container)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Local database per container &mdash; zero network latency during
            execution. Turso sync for cross-container visibility. Familiar
            SQL. Container dies &rarr; final sync &rarr; local state gone.
            <strong> Risk:</strong> sync complexity, conflict resolution.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="violet">
          <h4>ECS (@adobe/data)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Entity Component System with reactive change tracking.
            Schema-driven typed arrays. Purpose-built for high-frequency
            state mutations.
            <strong> Risk:</strong> niche dependency, unfamiliar paradigm,
            narrow community. Needs evaluation against our access patterns
            (heavily relational, not archetype-based).
          </p>
        </Card>
        <Card accent="red">
          <h4>Redis (shared state)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Already in the stack. Good for pub/sub and simple coordination
            signals. Shared across containers by default.
            <strong> Risk:</strong> bad for complex entity queries.
            No relations, no joins, no schema enforcement.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)", marginBottom: 12 }}>
        <h4 style={{ color: "var(--dim)" }}>Decision criteria</h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          Start with PostgreSQL &mdash; path of least surprise, all existing
          observability infrastructure is already there. Entity schema should
          be storage-agnostic: define in Drizzle, swap the backing store if
          measured write throughput demands it. Turso is the most likely
          upgrade path. ECS is a wildcard worth evaluating but not committing
          to early.
        </p>
      </Card>

      <hr />

      {/* ── Remaining end-game features ── */}
      <h3 style={{ marginBottom: 12 }}>Promote tool calls to first-class entities</h3>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--cyan)"
          name="Dedicated tool call table"
          description="Promote from JSONB metadata blobs to indexed, queryable rows. Tool name, args, result, duration, error. FK to TurnLog. Enables: 'show me every read_page call in this drive.'"
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Tool schema versioning"
          description="Record which tool definitions (and versions) were available per call. Tool definitions change over time — knowing exactly what was offered matters for debugging."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Reasoning capture"
          description="For reasoning models (Claude thinking, o1, o3), preserve extended thinking in TurnLog. The most valuable debugging artifact — the chain of thought that led to the action."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>Agent profiles &amp; institutional memory</h3>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="blue">
          <h4>Ratings accumulate</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Every agent config builds a track record over time. Which agents
            perform best on which task types. Cost efficiency per agent.
            Auto-selection of best agent for a given task based on history.
            Extends the existing AI usage analytics with quality signals.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Searchable decision history</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            &ldquo;How did we solve this last time?&rdquo; is a query, not a
            memory. Agent reasoning permanently indexed. Knowledge stays
            when people leave. The system compounds with every task completed.
            Built on the same hash-chained audit trail that already exists.
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>Open questions</h3>
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
