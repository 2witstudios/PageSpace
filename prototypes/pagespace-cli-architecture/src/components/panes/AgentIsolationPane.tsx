import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";

export function AgentIsolationPane() {
  return (
    <div className="pane">
      <div className="sl">Agent Isolation</div>
      <h2>
        Three context boundaries.
        <br />
        <span className="hl">No agent grades its own work.</span>{" "}
        <StatusBadge variant="methodology" />
      </h2>
      <p style={{ marginBottom: 10, maxWidth: 720 }}>
        If the same agent that wrote the code also reviews it, the score is
        meaningless. It will rationalize its own decisions every time.
      </p>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        The architecture enforces{" "}
        <strong>strict context isolation</strong>. Implementation, review, and
        meta-review run in separate BRANCH containers with separate
        conversations. They share only the specific inputs defined below.
      </p>

      <div className="g3" style={{ marginBottom: 24 }}>
        <Card accent="blue">
          <h3 style={{ color: "var(--blue)", marginBottom: 12 }}>
            Implementation
          </h3>
          <h4 style={{ color: "var(--green)" }}>Sees</h4>
          <p style={{ fontSize: 12 }}>
            Plan node, rubric, codebase state, task scope.
          </p>
          <h4 style={{ marginTop: 10, color: "var(--red)" }}>Blind to</h4>
          <p style={{ fontSize: 12 }}>
            Previous failed attempts' reasoning. Review feedback.
          </p>
          <h4 style={{ marginTop: 10, color: "var(--amber)" }}>Produces</h4>
          <p style={{ fontSize: 12 }}>
            Mutations, commits, full chat history.
          </p>
        </Card>
        <Card accent="cyan">
          <h3 style={{ color: "var(--cyan)", marginBottom: 12 }}>Review</h3>
          <h4 style={{ color: "var(--green)" }}>Sees</h4>
          <p style={{ fontSize: 12 }}>
            Code diffs, rubric, surrounding context.
          </p>
          <h4 style={{ marginTop: 10, color: "var(--red)" }}>Blind to</h4>
          <p style={{ fontSize: 12 }}>
            Implementation conversation, reasoning, tool calls.
          </p>
          <h4 style={{ marginTop: 10, color: "var(--amber)" }}>Produces</h4>
          <p style={{ fontSize: 12 }}>
            Per-dimension scores with justification.
          </p>
        </Card>
        <Card accent="violet">
          <h3 style={{ color: "var(--violet)", marginBottom: 12 }}>
            Meta-Review
          </h3>
          <h4 style={{ color: "var(--green)" }}>Sees</h4>
          <p style={{ fontSize: 12 }}>
            All ratings, all mutations, plan acceptance criteria.
          </p>
          <h4 style={{ marginTop: 10, color: "var(--red)" }}>Blind to</h4>
          <p style={{ fontSize: 12 }}>
            Implementation reasoning. Individual review reasoning.
          </p>
          <h4 style={{ marginTop: 10, color: "var(--amber)" }}>Produces</h4>
          <p style={{ fontSize: 12 }}>
            Coherence score. Cross-cutting concerns. Plan verdict.
          </p>
        </Card>
      </div>

      <div className="g2">
        <Card accent="green">
          <h4>Every agent is a visible conversation</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Each one appears in the sidebar, nested under its parent. Watch a
            supervisor reason about sub-agent work. Click into any agent to see
            its full history and the code it produced.
          </p>
        </Card>
        <Card accent="red">
          <h4>You can intervene at any time</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Pause mid-execution. Inject a message. Kill it and let the
            supervisor recover. Human oversight is built into the conversation
            model.
          </p>
        </Card>
      </div>

      <hr />
      <div className="sl">Context Logging &amp; Memory</div>
      <p style={{ marginBottom: 16, maxWidth: 720 }}>
        Two capabilities turn agent conversations from ephemeral chat into a
        permanent, auditable knowledge base.
      </p>
      <div className="g2">
        <Card accent="cyan">
          <h4>
            Turn-level context logging <StatusBadge variant="planned" />
          </h4>
          <p style={{ marginTop: 6, fontSize: 12, lineHeight: 1.8 }}>
            Every LLM call is recorded as a{" "}
            <strong style={{ color: "var(--text)" }}>TurnLog</strong> entity.
            The exact system prompt, the full message array sent, the model and
            provider used, token counts, latency, and the raw response. Not just
            what the agent said — exactly what it saw when it decided what to
            say. This makes every agent decision fully auditable and
            reproducible.
          </p>
        </Card>
        <Card accent="violet">
          <h4>
            Persistent agent memory <StatusBadge variant="planned" />
          </h4>
          <p style={{ marginTop: 6, fontSize: 12, lineHeight: 1.8 }}>
            Agents can write to and read from a persistent{" "}
            <strong style={{ color: "var(--text)" }}>AgentMemory</strong> store
            scoped at multiple levels: per-context (dies with the conversation),
            per-task (shared across retries), per-plan (shared across tasks), or
            global (persists across everything). Memory entries trace back to the
            turn that created them. Long-term learnings accumulate as the system
            works.
          </p>
        </Card>
      </div>
    </div>
  );
}
