import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function RuntimePane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        The agentic loop{" "}
        <span className="hl">already exists.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        PageSpace AI isn&apos;t a chatbot waiting for a runtime to be built.
        Agents run in a <strong>finish-tool-driven loop</strong> &mdash; the
        LLM plans, calls tools, evaluates results, and keeps going until{" "}
        <em>it</em> decides the work is done and calls <code>finish()</code>.
        The agent controls the loop, not a step counter. Agents delegate to
        other agents via <code>ask_agent</code> (2 levels deep, persistent
        conversations). Workflows already run on <strong>cron schedules</strong>{" "}
        and <strong>event triggers</strong>. The system is a lot closer to
        always-on than it looks.
      </p>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Entry points:{" "}
        <code>apps/web/src/app/api/ai/chat/route.ts</code> (per-page agent) and{" "}
        <code>apps/web/src/app/api/ai/global/[id]/messages/route.ts</code>{" "}
        (global assistant). Both use <code>streamText()</code> with{" "}
        <code>hasToolCall(&apos;finish&apos;)</code> as the stop condition.
      </p>

      <Card style={{ marginBottom: 24, padding: "20px 24px" }}>
        <pre>
          {"trigger (user / cron / event / ??? new triggers below)\n"}
          {"  |\n"}
          {"  v\n"}
          {"streamText(model, messages, 40 tools)\n"}
          {"  |\n"}
          {"  v\n"}
          {"LLM reasons → calls tools → gets results  <--+\n"}
          {"  |                                           |\n"}
          {"  v                                           |\n"}
          {"Execute tools (40 tools, 14 modules)          |\n"}
          {"  |                                           |\n"}
          {"  v                                           |\n"}
          {"LLM evaluates results → needs more work? -----+\n"}
          {"  |\n"}
          {"  v\n"}
          {"Agent calls finish() → done\n"}
          {"\n"}
          {"THE AGENT DECIDES WHEN TO STOP. The gap is: what triggers it."}
        </pre>
      </Card>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>40 tools across 14 modules</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Drive CRUD, page read/write, search (glob, regex, multi-drive),
            task management, agent communication, calendar (full CRUD),
            channels, activity history, GitHub import, web search, and a{" "}
            <code>finish</code> signal. Tools gated per agent via{" "}
            <code>enabledTools</code>.
          </p>
        </Card>
        <Card accent="green">
          <h4>Agent-to-agent delegation</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            <code>ask_agent</code> calls another AI_CHAT page with its own
            model, prompt, and tools. <strong>Persistent conversations</strong>{" "}
            via <code>conversationId</code>. 2-level depth, 20 steps per
            nested call. Agent lists cached in Redis (5-min TTL).
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Cron scheduling (live)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            <code>workflows</code> table with <code>cronExpression</code>,
            timezone, <code>nextRunAt</code>. Polled every 5 minutes via
            HMAC-signed cron container. Batch execution (5 concurrent),
            stuck-workflow recovery (10-min timeout), atomic claiming via
            UPDATE&hellip;RETURNING.
          </p>
        </Card>
        <Card accent="green">
          <h4>Event triggers (live)</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Activity log hook fires on any operation + resource type match.{" "}
            <code>watchedFolderIds</code> for folder scoping.{" "}
            <code>eventDebounceSecs</code> (default 30s) prevents trigger
            storms. Recursive trigger prevention for AI-generated events.
            Wired up in <code>instrumentation.ts</code> at startup.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>10 providers, 100+ models</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            PageSpace (GLM), OpenRouter, Anthropic, OpenAI, Google, xAI,
            Ollama, LMStudio, GLM (Zhipu), MiniMax. Drive-scoped system
            prompts, personalization, page tree context, timezone awareness.
            MCP tool injection via desktop WebSocket bridge.
          </p>
        </Card>
        <Card accent="green">
          <h4>Usage tracking + tier limits</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            <code>aiUsageLogs</code>: tokens, cost, duration, context size
            per request. Tier limits (free: 50, pro: 200, business: 1000/day)
            via Redis atomic increment. Provider pricing tables for cost
            calculation. Real-time streaming via SSE + Socket.IO broadcast.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── The Gap ── */}
      <div className="sl">The Gap</div>
      <h2>
        Four new triggers.{" "}
        <span className="hl">That&apos;s it.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The agentic loop exists. Cron triggers exist. Event triggers exist.
        The agent-to-agent delegation exists. What&apos;s missing is four
        more ways to fire the loop &mdash; each one unlocking a different
        kind of always-on behavior. These aren&apos;t new systems. They&apos;re
        new entries into the same execution engine.
      </p>

      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--amber)"
          name="Background loops"
          description="A bash-style loop that keeps an agent running: execute, wait, re-trigger, repeat. The agent doesn't stop when the request ends &mdash; it becomes a persistent background process. Think systemd for agents."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Task list triggers"
          description="When a task is created or updated on a task list, fire the assigned agent. The task list becomes a work queue. Agents pick up tasks, execute them, mark them done. Humans and agents feed the same queue."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Calendar event triggers"
          description="When a calendar event fires, trigger the associated agent. Daily standup summaries. Weekly report generation. Meeting prep that runs 30 minutes before the event. Agents use the calendar they already have."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Webhook triggers (Slack)"
          description="External events (Slack messages, GitHub webhooks, inbound email) trigger agents. A Slack message in a channel becomes a task. A GitHub PR triggers a review agent. The outside world feeds the loop."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <Card accent="blue" style={{ marginBottom: 12 }}>
        <h4 style={{ color: "var(--blue)" }}>Why this is close, not far</h4>
        <p style={{ fontSize: 12 }}>
          Each of these triggers feeds into the <em>same</em> execution
          path that cron and event triggers already use:{" "}
          <code>executeWorkflow()</code> calls <code>generateText()</code>{" "}
          with the agent&apos;s model, prompt, tools, and context. The
          workflow executor already handles status tracking, error recovery,
          usage logging, and tool filtering. A new trigger type is a new
          row in the <code>triggerType</code> enum and a new listener &mdash;
          not a new execution engine.
        </p>
      </Card>

      <hr />

      {/* ── Competitive Context ── */}
      <div className="sl">Competitive Context</div>
      <h2>
        The market is building{" "}
        <span className="hl">agent runtimes from scratch.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Competitors are spending massive effort building the runtime layer
        that PageSpace already has. They&apos;re wiring up tool execution,
        multi-step loops, and scheduling. PageSpace shipped all of that.
        The competitive edge: agents already live inside the workspace with
        real data, real tools, and real state.
      </p>

      <FeatureRow columns={3} style={{ marginBottom: 0 }}>
        <Feature
          nameColor="var(--red)"
          name="OpenFang"
          description="Rust single-binary agent OS. Autonomous &ldquo;Hands&rdquo; on schedules. WASM dual-metered sandbox. Per-agent budgets. FangHub skill marketplace. 38 built-in tools. Impressive runtime, but agents connect to external data &mdash; they don't live inside a workspace."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Devin / Cursor"
          description="Full VM sandboxes for code execution. Devin: test-debug-fix loop in cloud VMs. Cursor: background agents that clone repos and open PRs. Both prove containers matter &mdash; but they're pure dev tools, not workspace-native agents."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Viktor AI"
          description="Slack-native autonomous agent with persistent cloud VM. Learns skills through conversation. Confirmation gates on high-stakes actions. 3,000+ integrations. Closest to the &ldquo;always-on coworker&rdquo; model. The UX to study."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>
      <FeatureRow columns={2}>
        <Feature
          nameColor="var(--violet)"
          name="LangGraph / CrewAI"
          description="Developer frameworks for multi-agent orchestration. LangGraph: stateful graphs with checkpointing. CrewAI: role-based agent crews. Both powerful but they're frameworks, not platforms &mdash; you still need to build the workspace, the tools, and the data layer."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="OpenClaw"
          description="Self-hosted Node.js agent with multi-channel inbox (Slack, Discord, WhatsApp, iMessage). Per-session workspaces. Precedence-ordered skill directories. The Claude Code fork for personal agents &mdash; powerful individually but no shared workspace or persistent state."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <Card style={{ borderColor: "var(--border2)", marginBottom: 12 }}>
        <h4 style={{ color: "var(--dim)" }}>PageSpace&apos;s structural advantage</h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          Every competitor above builds a runtime that connects to external
          data. PageSpace agents already live inside the workspace &mdash;
          40 tools, 89-table database, page tree as filesystem, persistent
          conversations, real-time collaboration, cron + event workflows.
          They&apos;re building the foundation PageSpace already shipped.
          PageSpace just needs four more trigger types to go always-on.
        </p>
      </Card>

      <hr />

      {/* ── End Game ── */}
      <div className="sl">End Game</div>
      <h2>
        Always on.{" "}
        <span className="hl">Constantly learning.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        With the four triggers added, PageSpace agents become persistent
        processes in the OS metaphor. They watch task lists, respond to
        calendar events, listen on Slack, and loop in the background. They
        use the same 40 tools, the same workspace, the same page tree. The
        agent loop doesn&apos;t change &mdash; it just never stops.
      </p>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        The workspace becomes a living system. Agents learn from activity,
        build context over time, and operate continuously. Not a chatbot
        you talk to &mdash; a team member that&apos;s always working.
      </p>

      <ArchDiagram>
        <ArchRow label="Triggers" labelSub="what starts the loop">
          <ArchNode
            title="Human"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Chat message to any agent<br>Manual workflow trigger<br>ask_agent delegation"
          />
          <ArchNode
            title="Cron"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="live" />}
            detail="cronExpression + timezone<br>5-min polling, batch execution<br>HMAC-signed, atomic claiming"
          />
          <ArchNode
            title="Events"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Activity log hooks<br>operation + resourceType match<br>Folder scoping, debounce"
          />
          <ArchNode
            title="New Triggers"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.4)"
            status={<StatusBadge variant="planned" />}
            detail="Background loops (persistent)<br>Task list changes<br>Calendar events<br>Webhooks (Slack, GitHub)"
          />
        </ArchRow>

        <ArchConnector text="all triggers feed the same execution engine" />

        <ArchRow label="Engine" labelSub="already built">
          <ArchNode
            title="Workflow Executor"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.4)"
            style={{ border: "2px solid rgba(61,214,140,0.4)", flex: 2 }}
            status={<StatusBadge variant="live" />}
            detail="executeWorkflow() &rarr; generateText() with 40 tools<br>Finish-tool-driven loop &middot; multi-provider &middot; budget tracking<br>Status tracking &middot; error recovery &middot; usage logging<br>The same engine for every trigger type"
          />
          <ArchNode
            title="Realtime"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Socket.IO &middot; 13 event handlers<br>Streams output to browsers<br>Per-event auth &middot; presence<br>Human sees what agents do"
          />
        </ArchRow>
      </ArchDiagram>

      <div className="sl">What Changes</div>
      <h2>
        Four triggers and a{" "}
        <span className="hl">background process model.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The execution engine stays the same. What changes is how agents get
        activated and how long they stay alive. Each trigger is a small
        addition to the existing workflow system.
      </p>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="amber">
          <h4>Background loops</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            A persistent process that calls <code>executeWorkflow()</code>
            in a loop with a configurable interval. The agent runs, sleeps,
            runs again. Survives across requests. The simplest path to
            &ldquo;always-on&rdquo; &mdash; a <code>setInterval</code> on
            the server that feeds the existing engine.
          </p>
        </Card>
        <Card accent="amber">
          <h4>Task list triggers</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Extend event triggers to watch task list mutations specifically.
            When a task is created or its status changes, fire the assigned
            agent with the task as context. The <code>update_task</code> and{" "}
            <code>get_assigned_tasks</code> tools already exist &mdash; this
            closes the loop so agents pick up work autonomously.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="amber">
          <h4>Calendar triggers</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            When a calendar event fires, trigger the associated agent. Seven
            calendar tools already exist (list, get, create, update, delete,
            invite, RSVP). Add a trigger that checks upcoming events and fires
            agents at the scheduled time. Agents that prepare for meetings,
            generate reports, or send daily summaries.
          </p>
        </Card>
        <Card accent="amber">
          <h4>Webhook triggers</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            An inbound webhook endpoint that maps external events to agent
            triggers. Slack message &rarr; agent processes it. GitHub PR &rarr;
            review agent fires. Inbound email &rarr; support agent responds.
            The <code>send_channel_message</code> tool already lets agents
            communicate back &mdash; webhooks let the outside world talk in.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)" }}>
        <h4 style={{ color: "var(--dim)" }}>The constantly-learning part</h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          Always-on agents don&apos;t just execute &mdash; they accumulate
          context. An agent watching a task list learns the team&apos;s
          patterns. An agent processing Slack messages builds institutional
          knowledge. An agent on a cron loop sees trends over time. The
          existing conversation persistence, drive-scoped prompts, and
          activity tools (<code>get_activity</code> with 30-day lookback)
          already provide the memory substrate. The triggers turn passive
          memory into active learning.
        </p>
      </Card>
    </div>
  );
}
