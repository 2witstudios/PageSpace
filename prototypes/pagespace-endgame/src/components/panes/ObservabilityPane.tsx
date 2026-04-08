import { Card } from "../ui/Card";
import { FeatureRow, Feature } from "../ui/FeatureRow";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";

export function ObservabilityPane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        Token tracking is solid.{" "}
        <span className="hl">Decision tracking is not.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        PageSpace tracks every LLM call&apos;s cost, tokens, model, and context
        window metrics. But it only samples the first 1,000 characters of
        prompts and completions &mdash; not enough to reproduce or debug
        agent decisions.
      </p>

      <h3 style={{ marginBottom: 12 }}>AI usage tracking</h3>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>What&apos;s tracked per LLM call</h4>
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
          <h4>Per-page usage API</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Aggregated billing metrics (cumulative tokens/cost). Current
            context window usage percentage vs model&apos;s context limit.
            HIPAA-aware auto-expiry via <code>AI_LOG_RETENTION_DAYS</code>
            (90-day default). Comprehensive pricing table for 100+ models.
          </p>
        </Card>
      </div>

      <h3 style={{ marginBottom: 12 }}>Activity &amp; error tracking</h3>
      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>User activities</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            All CRUD operations tracked with resource type/ID, drive/page
            context, session, IP, user agent. Metadata JSONB for custom fields.
          </p>
        </Card>
        <Card accent="green">
          <h4>Error logs</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Error name, message, stack trace, file/line/column. Resolution
            tracking: resolved flag, timestamp, who resolved, notes.
          </p>
        </Card>
        <Card accent="green">
          <h4>System logs</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Level-based (trace through fatal). Categorized (auth, api, ai,
            database). Request context, performance metrics (duration,
            memory), hostname/pid/version.
          </p>
        </Card>
      </div>

      <Card accent="amber" style={{ marginBottom: 12 }}>
        <h4>The sampling problem</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          Prompt and completion content is sampled at <strong>first 1,000
          characters only</strong>. A typical system prompt is 3,000-6,000
          tokens. Tool call parameters and results are not stored at all.
          This means you can see <em>that</em> an agent made a decision,
          but not <em>why</em>.
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
        Without full context capture, agent decisions are black boxes.
        You can see tokens and cost but not the reasoning, the tools
        called, or the full prompt that led to a decision.
      </p>

      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--red)"
          name="No full TurnLog"
          description="Only 1,000-char samples of prompt/completion. Can't reproduce an agent's decision. Can't replay with the same inputs. Can't audit what it saw."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No tool call logging"
          description="When an agent calls read_page or create_page, the parameters and results aren't stored. Can't trace: what did the agent read before making that change?"
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
          name="No entity state layer"
          description="No Plan, Task, Mutation, Rating entities connecting the chain from intent to code to review. Changes happen but there's no structured traceability."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="red">
          <h4>No tool schema tracking</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Which tools were available to the agent isn&apos;t recorded per
            call. An agent might have had different tools enabled at
            different points &mdash; no way to know after the fact.
          </p>
        </Card>
        <Card accent="red">
          <h4>No reasoning capture</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            For reasoning models (o1, o3), the extended thinking isn&apos;t
            preserved. The most valuable part of the agent&apos;s process
            &mdash; its reasoning chain &mdash; is lost.
          </p>
        </Card>
        <Card accent="red">
          <h4>No mutation &rarr; agent link</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Page versions track <em>that</em> content changed, but not
            which agent made the change or as part of which task. Activity
            logs have AI attribution but no structured entity chain.
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

      <h3 style={{ marginBottom: 12 }}>TurnLog &mdash; full context capture</h3>
      <div className="g2" style={{ marginBottom: 20 }}>
        <Card accent="cyan">
          <h4>What gets recorded per LLM call</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Exact system prompt sent. Full message array (every message the
            agent saw). Model, provider, temperature. Token counts, latency.
            Raw response including tool calls. Tool schemas that were
            available. Reasoning/thinking content if applicable.
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

      <h3 style={{ marginBottom: 12 }}>Entity state &mdash; the traceability chain</h3>
      <p style={{ marginBottom: 16, maxWidth: 720 }}>
        Every artifact links to every artifact it touches. &ldquo;Why does
        this code exist?&rdquo; is a one-query question.
      </p>

      <ArchDiagram>
        <ArchRow label="Intent" labelSub="why" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Plan"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Source of truth. Scope, description, rubric.<br>Tasks decomposed from plan."
          />
          <ArchNode
            title="Task"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            detail="Scoped work unit. Status, plan reference.<br>Assigned to agent contexts."
          />
        </ArchRow>

        <ArchConnector text="tasks assigned to agents" />

        <ArchRow label="Execution" labelSub="how" style={{ marginBottom: 8 }}>
          <ArchNode
            title="AgentContext"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            detail="Chat history = execution record.<br>Messages, tool calls, mutations."
          />
          <ArchNode
            title="TurnLog"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            detail="Exact LLM context per call.<br>System prompt, messages, model, tokens, response."
          />
          <ArchNode
            title="AgentMemory"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            detail="Persistent knowledge (4 scopes).<br>Traces back to source TurnLog."
          />
        </ArchRow>

        <ArchConnector text="execution produces artifacts" />

        <ArchRow label="Output" labelSub="what" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Mutation"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            detail="Append-only change record. File, diff.<br>Links to agent, plan node, commit, rating."
          />
          <ArchNode
            title="GitCommit"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            detail="Captured via hook. SHA, message.<br>Links to mutations, task, PR."
          />
          <ArchNode
            title="PR"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            detail="Scoped changeset. Commits, review.<br>Links to plan scope, snapshot."
          />
        </ArchRow>

        <ArchConnector text="output gets scored" />

        <ArchRow label="Quality" labelSub="how good">
          <ArchNode
            title="Rating"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            detail="Per-dimension scores against rubric.<br>Verdict: pass / partial / fail."
          />
          <ArchNode
            title="Rubric"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            detail="Dimensions with weights + gate thresholds.<br>Defines quality criteria per plan."
          />
        </ArchRow>
      </ArchDiagram>

      <h3 style={{ marginBottom: 12 }}>
        Open question: storage layer for entity state
      </h3>
      <p style={{ marginBottom: 16, maxWidth: 720 }}>
        Agent workloads produce high-frequency writes &mdash; potentially
        thousands of TurnLogs per second during peak execution across
        multiple agents. The storage layer for entity state is an
        <strong> open design question</strong> with real tradeoffs.
      </p>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Option A: PostgreSQL</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Simple, consistent with existing stack. All entity data in one
            place with existing Drizzle ORM. Joins across entity types.
            <strong> Risk:</strong> write volume may outgrow single Postgres
            during peak agent execution. Could work with partitioning.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Option B: Turso/SQLite per container</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Fast local writes during execution (zero network latency).
            Async sync back to central Postgres on task completion.
            <strong> Risk:</strong> sync complexity, conflict resolution,
            query limitations during execution.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="violet">
          <h4>Option C: ECS (@adobe/data)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Entity Component System built for reactive change tracking.
            Schema-driven typed arrays. Purpose-built for high-frequency
            state mutations. <strong>Risk:</strong> new dependency, unfamiliar
            paradigm, needs evaluation for our access patterns.
          </p>
        </Card>
        <Card accent="amber">
          <h4>Option D: Event sourcing</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Append-only log of all state changes. Materialized views for
            queries. Natural fit for audit trail. <strong>Risk:</strong>
            operational complexity, eventual consistency, replay overhead.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)" }}>
        <h4 style={{ color: "var(--dim)" }}>Decision criteria</h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          The right answer depends on measured write volume. Start with
          PostgreSQL (Option A) in the runtime service. If write throughput
          becomes a bottleneck during agent swarms, evaluate B/C/D. The
          entity schema should be storage-agnostic &mdash; define entities
          in Drizzle, swap the backing store later if needed.
        </p>
      </Card>

      <hr />

      <h3 style={{ marginBottom: 12 }}>Tool call logging</h3>
      <FeatureRow columns={3}>
        <Feature
          nameColor="var(--cyan)"
          name="Every invocation captured"
          description="Tool name, full parameters, complete result, duration, error (if any). Links to the TurnLog that triggered it. Enables: show me every read_page call in this drive."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Tool schema per call"
          description="Which tools were available to the agent at call time. Tool definitions change over time &mdash; knowing exactly what was offered matters for debugging."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Reasoning capture"
          description="For reasoning models (o1, o3), preserve the extended thinking. The most valuable debugging artifact &mdash; the chain of thought that led to the action."
          style={{ padding: "16px 14px", fontSize: 14 }}
        />
      </FeatureRow>

      <h3 style={{ marginBottom: 12 }}>Agent profiles &amp; institutional memory</h3>
      <div className="g2">
        <Card accent="blue">
          <h4>Ratings accumulate</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Every agent config builds a track record over time. Which agents
            perform best on which task types. Cost efficiency per agent.
            Auto-selection of best agent for a given task based on history.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Searchable decision history</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            &ldquo;How did we solve this last time?&rdquo; is a query, not a
            memory. Agent reasoning permanently indexed. Knowledge stays
            when people leave. The system compounds with every task completed.
          </p>
        </Card>
      </div>
    </div>
  );
}
