import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function ProductPane() {
  return (
    <div className="pane">
      <div className="sl">The Problem</div>
      <h2>
        AI can write code. Nobody can{" "}
        <span className="hl">see what it did or why.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        AI coding agents produce working code. But they operate as black boxes.
        There's no record of the reasoning behind each change. No structured way
        to evaluate quality. No link between the plan you started with and the
        code you got back. When an agent makes a bad decision, you can't see what
        information it was working with. When something breaks three months
        later, you're reading diffs with zero context about why any of it was
        written.
      </p>

      <FeatureRow>
        <Feature
          icon="⚡"
          nameColor="var(--blue)"
          name="Event-driven orchestration"
          status={<StatusBadge variant="planned" />}
          description='Define triggers for any event in your development workflow — file changes, commits, idle time, schedules, task completions. Each trigger fires <strong style="color:var(--text)">skills, commands, context lookups, memory operations, or scoring</strong> in any combination. The event system is the core primitive.'
        />
        <Feature
          icon="&#x1F441;"
          nameColor="var(--green)"
          name="Observable agents"
          status={<StatusBadge variant="planned" />}
          description='Every AI agent runs in a <strong style="color:var(--text)">cloud container with full shell access.</strong> BRANCH pages in PageSpace show agent status, conversations, and output in real time. Pause agents. Redirect them. Multiple agents per branch, all observable through PageSpace.'
        />
        <Feature
          icon="&#x1F517;"
          nameColor="var(--amber)"
          name="Full traceability"
          status={<StatusBadge variant="planned" />}
          description='Plans &rarr; tasks &rarr; agent conversations &rarr; mutations &rarr; commits &rarr; PRs &rarr; reviews &rarr; scores. <strong style="color:var(--text)">Nothing exists without a reason you can find.</strong> Every LLM call logged with the exact context window that produced it.'
        />
      </FeatureRow>

      <div className="sl">What Pagespace CLI Is</div>
      <h2>
        The <span className="hl">orchestration runtime</span> that PageSpace and
        PurePoint need.
        <br />
        Real loops. Real planning. Real power.
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        <a href="https://pagespace.ai">PageSpace</a> has the right data model —
        pages as universal primitives, hierarchical context, drives, permissions,
        version history, CLI tooling. But its agent runtime (Vercel AI SDK) is
        single-turn tool calls. No loops, no planning, no sub-agents, no gates.
      </p>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        <strong>PurePoint</strong> has the right orchestration model — triggers,
        gates, swarms, schedules, agent lifecycle management. But it treats
        agents as opaque PTY processes with no persistence, search, or
        permissions.
      </p>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        <strong>Pagespace CLI is the convergence.</strong> PurePoint's
        orchestration model (loops, triggers, gates, swarms) built into
        PageSpace — using pages, drives, and the page tree as the workspace.
        BRANCH pages backed by cloud containers give agents real shells. The
        Pagespace CLI, installed in every container, lets agents access
        PageSpace from the shell — memory, skills, tasks, other agents.
      </p>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        <a href="https://github.com/paralleldrive/aidd">AIDD</a> provides the
        development methodology today. Status badges indicate what exists vs
        what's planned.
      </p>

      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 20,
        }}
      >
        <StatusBadge variant="live" />
        <span style={{ fontSize: 12, color: "var(--mid)" }}>
          exists and works
        </span>
        <StatusBadge variant="methodology" />
        <span style={{ fontSize: 12, color: "var(--mid)" }}>
          AIDD prompt/workflow
        </span>
        <StatusBadge variant="spec" />
        <span style={{ fontSize: 12, color: "var(--mid)" }}>
          specification exists
        </span>
        <StatusBadge variant="planned" />
        <span style={{ fontSize: 12, color: "var(--mid)" }}>
          target architecture
        </span>
      </div>

      <FeatureRow columns={4} style={{ marginBottom: 28 }}>
        <Feature
          nameColor="var(--violet)"
          name="Swarms"
          description="Agent teams take one shot at each task. Pass means accept. Fail means fresh attempt. No infinite loops."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="Parallel analysis"
          description="Run N independent agents against the same code. Same prompt for consensus. Varied prompts for specialized review. AI slop detection. Shortcut hunting."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Visual builder"
          description="Wire up your AI workflow like a flowchart. Drag skill nodes. Set triggers and thresholds. No code required."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Scored output"
          description="When you want quality measured, independent reviewers score against structured rubrics. Per-dimension. Trackable."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="blue">
          <h4>
            Context logging <StatusBadge variant="planned" />
          </h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Every LLM call is recorded: the exact system prompt, the full
            message array sent, the model and provider, token counts, latency,
            and the raw response. When an agent makes a decision, you can see
            exactly what it was looking at. Fully auditable. Fully reproducible.
          </p>
        </Card>
        <Card accent="violet">
          <h4>
            Persistent memory <StatusBadge variant="planned" />
          </h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Agents read and write to a persistent memory store scoped at four
            levels: per-conversation, per-task, per-plan, or global. Learnings
            accumulate. A swarm that retries a failed task can read what went
            wrong last time. The system gets smarter over time.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 20 }}>
        <Card accent="green">
          <h4>Works with your existing tools</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Agents use git the way any developer does — commit, push, PR. Your
            GitHub repos and CI pipelines keep working. Pagespace CLI adds a
            semantic layer that makes AI-generated code traceable and scorable.
            It doesn't replace your stack. It makes it legible.
          </p>
        </Card>
        <Card accent="cyan">
          <h4>
            Cloud-native, model-agnostic <StatusBadge variant="planned" />
          </h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            BRANCH pages spin up cloud containers with real shells. Multiple
            agents per container. LLM calls route through any of 11 providers —
            switch models without code changes. Agents use the Pagespace CLI
            to access PageSpace from inside the container. Manage everything
            through PageSpace's existing web UI.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)" }}>
        <h4 style={{ color: "var(--dim)" }}>Not in v1</h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          Multiplayer cursor sync. Billing. Self-hosted deployment. Native
          desktop app.
        </p>
      </Card>
    </div>
  );
}
