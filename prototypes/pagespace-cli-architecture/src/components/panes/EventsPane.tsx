import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function EventsPane() {
  return (
    <div className="pane">
      <div className="sl">Events &amp; Triggers</div>
      <h2>
        The event system is <span className="hl">the actual product.</span>{" "}
        <StatusBadge variant="planned" />
      </h2>
      <p style={{ marginBottom: 10, maxWidth: 720 }}>
        The target architecture for Pagespace CLI is a programmable event
        system. You define what happens when. A trigger fires and the system
        responds with any combination of skills, commands, context lookups,
        memory operations, or scoring. Today, AIDD provides the methodology as
        human-driven prompt workflows. The event system described below will
        automate and orchestrate those workflows.
      </p>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        Not every code change gets evaluated against a rubric. Not every commit
        triggers a review. <strong>You decide what fires when.</strong> The
        event system is the primitive. Everything else — scoring, swarms,
        reviews — is built on top of it.
      </p>

      <div className="sl">Trigger Sources</div>
      <p style={{ marginBottom: 16 }}>
        Anything that happens in the system can be a trigger. These are the
        event sources:
      </p>
      <div className="g3" style={{ marginBottom: 24 }}>
        <Card accent="blue">
          <h4>Code events</h4>
          <p style={{ fontSize: 11, marginTop: 4, lineHeight: 1.7 }}>
            File saved. Mutation resolved. Git commit. PR opened. Diff exceeds
            threshold. File in a specific path changed. Test failed. Build
            broke.
          </p>
        </Card>
        <Card accent="violet">
          <h4>Agent events</h4>
          <p style={{ fontSize: 11, marginTop: 4, lineHeight: 1.7 }}>
            Agent spawned. Agent finished. Swarm passed. Swarm failed. Token
            budget exceeded. Agent idle. Supervisor decision point. Tool call
            completed.
          </p>
        </Card>
        <Card accent="amber">
          <h4>System events</h4>
          <p style={{ fontSize: 11, marginTop: 4, lineHeight: 1.7 }}>
            User idle. Schedule (cron). Task status changed. Plan node
            advanced. Rating produced. Memory written. Manual trigger. Webhook
            received.
          </p>
        </Card>
      </div>

      <div className="sl">Action Targets</div>
      <p style={{ marginBottom: 16 }}>
        When a trigger fires, it can invoke any combination of these:
      </p>
      <FeatureRow columns={5}>
        <Feature
          nameColor="var(--cyan)"
          name="Skills"
          description="Reusable agent capabilities. Review, refactor, test-gen, lint, document, translate. Registered in a skill catalog. Composable."
          style={{ padding: "18px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--violet)"
          name="Commands"
          description="Direct actions. Run tests. Git commit. Deploy. Notify. Spawn agent. Kill agent. Snapshot. Any shell command or system operation."
          style={{ padding: "18px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Context"
          description="Discover and inject relevant information. Search codebase. Find related plans. Load memories. Pull docs. Assemble the right context window."
          style={{ padding: "18px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--green)"
          name="Memory"
          description="Read or write persistent knowledge. Log a learning. Update a preference. Record a decision. At any scope: context, task, plan, global."
          style={{ padding: "18px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="Scoring"
          description="Evaluate against a rubric. Run a gate. Produce a rating. This is just one action type, not a default that runs on everything."
          style={{ padding: "18px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="sl" style={{ marginTop: 24 }}>
        Example Triggers
      </div>
      <div className="g2" style={{ marginBottom: 20 }}>
        <Card accent="violet">
          <h4 style={{ marginBottom: 12 }}>Pre-commit: run a skill</h4>
          <pre>
            <span className="c">
              {"# Before any commit, run the lint skill"}
            </span>
            {"\n- "}
            <span className="k">on</span>
            {": "}
            <span className="s">pre-commit</span>
            {"\n  "}
            <span className="k">do</span>
            {": "}
            <span className="t">skill</span>
            {"("}
            <span className="v">lint</span>
            {")\n  "}
            <span className="k">gate</span>
            {": "}
            <span className="s">must pass to commit</span>
            {"\n\n"}
            <span className="c">
              {"# Auth files get security review skill"}
            </span>
            {"\n- "}
            <span className="k">on</span>
            {": "}
            <span className="s">pre-commit</span>
            {"\n  "}
            <span className="k">when</span>
            {": "}
            <span className="s">{'files match "src/auth/**"'}</span>
            {"\n  "}
            <span className="k">do</span>
            {": "}
            <span className="t">skill</span>
            {"("}
            <span className="v">security-review</span>
            {")"}
          </pre>
        </Card>
        <Card accent="cyan">
          <h4 style={{ marginBottom: 12 }}>
            Post-mutation: discover context + score
          </h4>
          <pre>
            <span className="c">
              {"# Only score when the task says to"}
            </span>
            {"\n- "}
            <span className="k">on</span>
            {": "}
            <span className="s">{'task.status == "ready_for_review"'}</span>
            {"\n  "}
            <span className="k">do</span>
            {":\n    - "}
            <span className="t">context</span>
            {"("}
            <span className="v">find related tests</span>
            {")\n    - "}
            <span className="t">context</span>
            {"("}
            <span className="v">load plan rubric</span>
            {")\n    - "}
            <span className="t">skill</span>
            {"("}
            <span className="v">independent-review</span>
            {")\n    - "}
            <span className="t">score</span>
            {"("}
            <span className="v">task.rubric</span>
            {")"}
          </pre>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 20 }}>
        <Card accent="amber">
          <h4 style={{ marginBottom: 12 }}>
            Idle: pick up work + write memory
          </h4>
          <pre>
            <span className="c">{"# Developer steps away"}</span>
            {"\n- "}
            <span className="k">on</span>
            {": "}
            <span className="s">idle 5m</span>
            {"\n  "}
            <span className="k">when</span>
            {": "}
            <span className="s">{'tasks.any(status == "ready")'}</span>
            {"\n  "}
            <span className="k">do</span>
            {":\n    - "}
            <span className="t">context</span>
            {"("}
            <span className="v">load task plan + codebase</span>
            {")\n    - "}
            <span className="t">memory</span>
            {"("}
            <span className="v">read task-level learnings</span>
            {")\n    - "}
            <span className="t">command</span>
            {"("}
            <span className="v">dispatch-swarm</span>
            {")\n\n"}
            <span className="c">
              {"# After swarm completes, log what worked"}
            </span>
            {"\n- "}
            <span className="k">on</span>
            {": "}
            <span className="s">swarm.complete</span>
            {"\n  "}
            <span className="k">do</span>
            {": "}
            <span className="t">memory</span>
            {"("}
            <span className="v">write plan-scope</span>
            {",\n       "}
            <span className="s">
              {'"approach X worked for this pattern"'}
            </span>
            {")"}
          </pre>
        </Card>
        <Card accent="red">
          <h4 style={{ marginBottom: 12 }}>
            Chain: outcomes drive next steps
          </h4>
          <pre>
            <span className="c">
              {"# Scoring is opt-in, not automatic"}
            </span>
            {"\n- "}
            <span className="k">on</span>
            {": "}
            <span className="s">{'verdict == "pass"'}</span>
            {"\n  "}
            <span className="k">do</span>
            {": "}
            <span className="t">command</span>
            {"("}
            <span className="v">advance</span>
            {") + "}
            <span className="t">command</span>
            {"("}
            <span className="v">next-task</span>
            {")\n\n- "}
            <span className="k">on</span>
            {": "}
            <span className="s">{'verdict == "partial"'}</span>
            {"\n  "}
            <span className="k">do</span>
            {":\n    - "}
            <span className="t">context</span>
            {"("}
            <span className="v">load failed dimensions</span>
            {")\n    - "}
            <span className="t">skill</span>
            {"("}
            <span className="v">targeted-fix</span>
            {")\n\n- "}
            <span className="k">on</span>
            {": "}
            <span className="s">all_tasks_complete</span>
            {"\n  "}
            <span className="k">do</span>
            {": "}
            <span className="t">skill</span>
            {"("}
            <span className="v">meta-review</span>
            {")"}
          </pre>
        </Card>
      </div>

      <div className="sl">The Skill Catalog</div>
      <p style={{ marginBottom: 16 }}>
        Skills are named, reusable agent capabilities registered in the system.
        They define what an agent does, what context it needs, and what it
        produces.
      </p>
      <div className="g3" style={{ marginBottom: 20 }}>
        <Card style={{ borderLeft: "3px solid var(--cyan)" }}>
          <h4>Built-in skills</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>
            independent-review, targeted-fix, meta-review, test-gen, lint,
            refactor, document, decompose
          </p>
        </Card>
        <Card style={{ borderLeft: "3px solid var(--violet)" }}>
          <h4>Custom skills</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>
            User-defined. Custom system prompt, tool set, context requirements,
            output schema. Register once, trigger anywhere.
          </p>
        </Card>
        <Card style={{ borderLeft: "3px solid var(--amber)" }}>
          <h4>Discoverable</h4>
          <p style={{ fontSize: 11, marginTop: 4 }}>
            Agents can query the skill catalog at runtime. A supervisor can
            discover which skills are available and decide which to invoke
            based on the task.
          </p>
        </Card>
      </div>

      <Card accent="blue">
        <h4>Context discovery is a first-class action</h4>
        <p style={{ marginTop: 6, fontSize: 12, lineHeight: 1.8 }}>
          Before an agent acts, it needs the right information. Context
          discovery is not implicit — it's an explicit, configurable step in the
          trigger chain. "Find related tests." "Load the plan rubric." "Search
          for similar past mutations." "Read task-level memories." "Pull the
          relevant docs." Each context action is logged in the TurnLog so you
          can see exactly what information the agent had when it made each
          decision.
        </p>
      </Card>
    </div>
  );
}
