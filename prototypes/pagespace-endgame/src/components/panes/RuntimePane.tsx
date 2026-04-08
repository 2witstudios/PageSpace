import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
} from "../ui/ArchDiagram";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function RuntimePane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        Multi-tool agents, but{" "}
        <span className="hl">request-bound execution.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        PageSpace AI is more capable than a simple chatbot. Each request can
        trigger multiple tool calls, agents delegate to other agents via
        <code> ask_agent</code> (up to 2 levels deep), and task management
        tools let agents track work across conversations. Workflows exist with
        cron scheduling. But all execution is <strong>request-bound</strong>
        &mdash; a human initiates it, <code>streamText()</code> runs the tools,
        and the LLM decides when to stop. No autonomous loops, no CLI
        execution, no skill registry, no budget tracking.
      </p>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Entry points:{" "}
        <code>apps/web/src/app/api/ai/chat/route.ts</code> (per-page chat) and{" "}
        <code>apps/web/src/app/api/ai/global/[id]/messages/route.ts</code>{" "}
        (global assistant).
      </p>

      <Card style={{ marginBottom: 24, padding: "20px 24px" }}>
        <pre>
          {"User message\n"}
          {"  |\n"}
          {"  v\n"}
          {"streamText(model, messages, tools)\n"}
          {"  |\n"}
          {"  v\n"}
          {"LLM response (may include tool calls)\n"}
          {"  |\n"}
          {"  v\n"}
          {"Tool calls execute (in Node.js process, no sandbox)\n"}
          {"  |\n"}
          {"  v\n"}
          {"Response to user (done — single turn, no loop)"}
        </pre>
      </Card>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>What works</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            33+ tools across page CRUD, search, navigation, task management,
            and integrations. Multi-provider support (Anthropic, OpenAI, Google,
            xAI, OpenRouter, Ollama). 100+ models. Drive-scoped system prompts.
          </p>
        </Card>
        <Card accent="green">
          <h4>Agent awareness</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Agents see the page tree, other agents in the drive, and can call{" "}
            <code>ask_agent</code> for cross-agent delegation. Agent list and
            page tree are cached in Redis with a 5-minute TTL.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Workflows + cron</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Workflows table has <code>cronExpression</code>, timezone, event
            triggers, and folder watches. The cron container fires workflow
            execution every 5 minutes via
            <code> POST /api/cron/workflows</code>. Schema is there &mdash;
            but workflows still trigger tool-call agents, not CLI loops.
          </p>
        </Card>
        <Card accent="green">
          <h4>Real-time streaming</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Responses stream to the browser via the Vercel AI SDK&apos;s
            streaming protocol. Socket.IO broadcasts updates to other
            viewers of the same page. Live collaboration works today.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── Gaps ── */}
      <div className="sl">Gaps</div>
      <h2>
        Powerful per-request, but{" "}
        <span className="hl">no autonomous execution.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Agents can do a lot within a single request &mdash; multiple tool calls,
        cross-agent delegation, task management. But they can&apos;t loop back to
        evaluate their own work, schedule themselves, or operate without a human
        trigger. The gaps are about autonomy, not capability.
      </p>

      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--red)"
          name="No autonomous loops"
          description="Agents execute within a single request. They can't loop back to evaluate, retry, or refine without a human re-prompting. No plan/execute/evaluate cycle."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No plan/evaluate"
          description="No ability to break a task into steps, execute them, evaluate results, and adjust. No gate checks, no success criteria, no escalation."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Scheduling is limited"
          description="Workflows support cron + event triggers, but they fire tool-call agents, not CLI loops. No autonomous multi-step execution. The scheduling infra exists — the runtime to power it doesn't."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No budget enforcement"
          description="No per-agent cost limits, no token caps per hour or day. No automatic pause when budget exhausted. No usage reports per agent."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="red">
          <h4>No CLI-based execution</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Tools run inside the Node.js API process. No shell, no filesystem,
            no git. Agents manipulate pages through API tools, not through a
            real development environment.
          </p>
        </Card>
        <Card accent="amber">
          <h4>Workflows lack DAG execution</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Workflow schema exists (cron, triggers, folder watches) but no
            multi-step pipelines, fan-out/fan-in, conditionals, or retry logic.
            The scheduling plumbing is there &mdash; the execution engine isn't.
          </p>
        </Card>
        <Card accent="red">
          <h4>No skill discovery</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Tools are hardcoded per agent type. No dynamic skill registry, no
            skill composition, no ability for agents to discover and load new
            capabilities at runtime.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        The engine that runs agents.{" "}
        <span className="hl">Built into PageSpace.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        The runtime service adds everything missing as a new app in the
        monorepo: <code>apps/runtime/</code>. It shares the same database,
        auth, and types as the rest of the platform. This is the major new work.
      </p>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        The implementation lives in PageSpace&apos;s TypeScript monorepo as a new
        service, sharing the same database, auth, and types as the rest of
        the platform.
      </p>

      <ArchDiagram>
        <ArchRow label="PageSpace" labelSub="monorepo" style={{ marginBottom: 8 }}>
          <ArchNode
            title="apps/web"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Next.js 15 &middot; UI + API routes<br>Agent config, skill editing, dashboards<br>Workflow builder, monitoring<br>The human interface"
          />
          <ArchNode
            title="apps/runtime"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Agent loops &middot; scheduling &middot; workflows<br>Tool execution &middot; LLM routing<br>Budget metering &middot; trigger engine<br>The agent execution engine"
          />
          <ArchNode
            title="apps/realtime"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Socket.IO server<br>Streams runtime output to browsers<br>Per-event auth &middot; presence<br>The bridge to humans"
          />
          <ArchNode
            title="packages/db"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Drizzle ORM &middot; PostgreSQL<br>Shared schema across all apps<br>Agent state, workflows, triggers<br>Single source of truth"
          />
        </ArchRow>
      </ArchDiagram>

      <div className="sl">The Agent Loop</div>
      <h2>
        Plan &rarr; execute &rarr; evaluate &rarr;{" "}
        <span className="hl">loop or stop.</span>
      </h2>

      <Card style={{ marginBottom: 24, padding: "20px 24px" }}>
        <pre>
          {"receive task (from user, schedule, trigger, or parent agent)\n"}
          {"  |\n"}
          {"  v\n"}
          {"build context (system prompt + skills + memory + page tree)\n"}
          {"  |\n"}
          {"  v\n"}
          {"call LLM (multi-provider, failover, context overflow recovery)\n"}
          {"  |\n"}
          {"  v\n"}
          {"parse response (text, tool calls, delegation requests)\n"}
          {"  |\n"}
          {"  v\n"}
          {"execute tools (sandboxed, capability-gated, budget-checked)\n"}
          {"  |\n"}
          {"  v\n"}
          {"evaluate (gate check: pass/partial/fail)\n"}
          {"  |          |            |\n"}
          {"  v          v            v\n"}
          {"done    loop (fix)    escalate (to parent or human)\n"}
        </pre>
      </Card>

      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--blue)"
          name="Scheduling"
          description="Cron expressions, event triggers, autonomous modes. Agents run on schedules, react to events, or loop continuously. Persistent across restarts."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--violet)"
          name="Workflows"
          description="Multi-step pipelines with fan-out (parallel), fan-in (collect), conditionals, loops, gates, and retry logic. Visual builder in the web UI."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Budget / Metering"
          description="Token limits per agent, per hour, per day. Cost tracking across providers. Automatic pause when budget exhausted. Reports usage to billing."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Tool Execution"
          description="Capability-gated tool calls. Each agent declares what tools it needs. Runtime enforces the boundary. Sandboxed execution for untrusted tools."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="sl">Key Design Decisions</div>
      <h2>
        Patterns that make the loop{" "}
        <span className="hl">production-grade.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        A reliable agent loop needs more than &quot;call LLM, run tools, repeat.&quot;
        These are the design decisions that keep agents from running off the rails:
      </p>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="blue">
          <h4>Loop guards</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            SHA256 hashing of tool calls to detect cycles. If an agent
            makes the same tool call twice in a row, it&apos;s stuck. Break the
            loop. Prevents runaway execution and wasted tokens.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Context overflow</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            When the context window fills up, truncate tool results
            first, then older messages. Dynamic trimming based on model limits.
            Graceful degradation instead of hard failures.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Session compaction</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Sliding window keeps recent 50 messages. Older messages summarized.
            Multi-phase repair if a session corrupts. Adapted for PostgreSQL-backed
            conversations with full team visibility.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)" }}>
        <h4 style={{ color: "var(--dim)" }}>Why TypeScript?</h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          The runtime shares types, schema, and auth with the rest of PageSpace.
          Same Drizzle models, same token validation, same permission functions.
          No API boundary, no type duplication. The hot path (LLM calls) is
          I/O-bound, not CPU-bound &mdash; TypeScript performs well here and
          keeps the entire stack in one language.
        </p>
      </Card>
    </div>
  );
}
