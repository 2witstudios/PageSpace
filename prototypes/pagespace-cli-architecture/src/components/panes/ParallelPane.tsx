import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import { ScoreBar } from "../ui/ScoreBar";
import { Pill } from "../ui/Pill";

export function ParallelPane() {
  return (
    <div className="pane">
      <div className="sl">Parallel Analysis</div>
      <h2>
        Run N independent agents against the{" "}
        <span className="hl">same problem.</span>
        <br />
        Compare what they find. <StatusBadge variant="planned" />
      </h2>
      <p style={{ marginBottom: 10, maxWidth: 720 }}>
        A single agent reviewing code gives you one opinion. It might be right.
        It might be confidently wrong. It might miss the same things every time
        because of patterns baked into its training data.
      </p>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        Parallel analysis spawns{" "}
        <strong>multiple independent contexts</strong> — either with the same
        prompt or deliberately varied prompts — against the same input. Each
        agent works in isolation. None can see what the others are doing. Then
        you compare the outputs. Where they agree, you have confidence. Where
        they diverge, you have signal.
      </p>

      <div className="sl">Modes</div>
      <div className="g2" style={{ marginBottom: 24 }}>
        <Card accent="blue">
          <h3 style={{ color: "var(--blue)", marginBottom: 10 }}>
            Same Prompt, N Contexts
          </h3>
          <p style={{ fontSize: 12, lineHeight: 1.8 }}>
            All agents get identical instructions. You're testing for{" "}
            <strong style={{ color: "var(--text)" }}>
              consensus and divergence
            </strong>
            . If 5 out of 5 agents flag the same function as problematic, that's
            a real issue. If 3 say the approach is fine and 2 say it needs
            refactoring, that's an ambiguous area that needs human attention.
            Divergence IS the signal.
          </p>
        </Card>
        <Card accent="violet">
          <h3 style={{ color: "var(--violet)", marginBottom: 10 }}>
            Varied Prompts, N Contexts
          </h3>
          <p style={{ fontSize: 12, lineHeight: 1.8 }}>
            Each agent gets a{" "}
            <strong style={{ color: "var(--text)" }}>different lens</strong>.
            One reviews for security. One for performance. One specifically hunts
            for AI-generated shortcuts. One checks for training data pollution
            (anti-patterns that LLMs reproduce because they're overrepresented
            in training data). One evaluates test coverage. Specialized
            perspectives that a single generalist review would miss.
          </p>
        </Card>
      </div>

      <div className="sl">Use Cases</div>
      <div className="g3" style={{ marginBottom: 24 }}>
        <Card accent="cyan">
          <h4>Greenfield path analysis</h4>
          <p style={{ fontSize: 11, marginTop: 6, lineHeight: 1.7 }}>
            Before writing any code, spawn N agents to independently propose an
            implementation approach for the same task. Compare their
            architectural choices. Where they converge, that's the obvious path.
            Where they diverge, those are the real design decisions that need
            human judgment. Use the comparison to write a better plan.
          </p>
        </Card>
        <Card accent="red">
          <h4>Shortcut detection</h4>
          <p style={{ fontSize: 11, marginTop: 6, lineHeight: 1.7 }}>
            After implementation, run N independent reviewers with the prompt:
            "Where would you cut corners if you were rushing this?" Agents will
            flag the same weak spots that an AI implementer is likely to skip —
            incomplete error handling, missing edge cases, hardcoded values,
            shallow tests. The patterns they agree on are the patterns to watch
            for.
          </p>
        </Card>
        <Card accent="amber">
          <h4>Decomposition validation</h4>
          <p style={{ fontSize: 11, marginTop: 6, lineHeight: 1.7 }}>
            Give N agents the same plan and ask each to independently break it
            into tasks. Compare their decompositions. Tasks that every agent
            identifies are clearly scoped. Boundaries that differ across agents
            are where scope is ambiguous and needs tighter definition before any
            implementation starts.
          </p>
        </Card>
      </div>

      <div className="g3" style={{ marginBottom: 24 }}>
        <Card style={{ borderLeft: "3px solid var(--red)" }}>
          <h4>AI slop detection</h4>
          <p style={{ fontSize: 11, marginTop: 6, lineHeight: 1.7 }}>
            Dedicated review context with a prompt tuned for common LLM failure
            modes: unnecessary abstractions, over-engineered patterns, verbose
            comments that restate the code, placeholder error messages,
            cargo-culted patterns from training data, inconsistent naming that
            drifts across a long context window.
          </p>
        </Card>
        <Card style={{ borderLeft: "3px solid var(--green)" }}>
          <h4>Training data pollution audit</h4>
          <p style={{ fontSize: 11, marginTop: 6, lineHeight: 1.7 }}>
            Review context specifically looking for anti-patterns that LLMs
            reproduce because they're overrepresented in training data:
            jQuery-era DOM manipulation in modern React, class-based components
            when hooks are standard, var instead of const/let, callback hell
            instead of async/await, outdated security patterns.
          </p>
        </Card>
        <Card style={{ borderLeft: "3px solid var(--violet)" }}>
          <h4>Section-specific deep review</h4>
          <p style={{ fontSize: 11, marginTop: 6, lineHeight: 1.7 }}>
            Break a PR into logical sections. Each section gets its own reviewer
            with a prompt tuned for that area: auth logic gets a
            security-focused reviewer, data layer gets a performance reviewer, UI
            gets an accessibility reviewer. Deeper analysis than any single
            generalist pass.
          </p>
        </Card>
      </div>

      <div className="sl">How It Works in the Event System</div>
      <div className="g2" style={{ marginBottom: 20 }}>
        <Card accent="violet">
          <h4 style={{ marginBottom: 12 }}>
            Trigger: spawn parallel contexts
          </h4>
          <pre>
            <span className="c">{"# On PR ready for review"}</span>
            {"\n"}
            <span className="c">
              {"# spawn 5 independent review contexts"}
            </span>
            {"\n- "}
            <span className="k">on</span>
            {": "}
            <span className="s">{'pr.status == "ready_for_review"'}</span>
            {"\n  "}
            <span className="k">do</span>
            {":\n    - "}
            <span className="t">parallel</span>
            {"("}
            <span className="v">count: 5</span>
            {"):\n        "}
            <span className="t">skill</span>
            {"("}
            <span className="v">independent-review</span>
            {")\n        "}
            <span className="t">context</span>
            {"("}
            <span className="v">pr.mutations + rubric</span>
            {")\n    - "}
            <span className="t">await_all</span>
            {"\n    - "}
            <span className="t">skill</span>
            {"("}
            <span className="v">consensus-analysis</span>
            {")"}
          </pre>
        </Card>
        <Card accent="cyan">
          <h4 style={{ marginBottom: 12 }}>
            Trigger: varied specialized lenses
          </h4>
          <pre>
            <span className="c">
              {"# Each context gets a different focus"}
            </span>
            {"\n- "}
            <span className="k">on</span>
            {": "}
            <span className="s">{'pr.status == "ready_for_review"'}</span>
            {"\n  "}
            <span className="k">do</span>
            {":\n    - "}
            <span className="t">parallel</span>
            {":\n        - "}
            <span className="t">skill</span>
            {"("}
            <span className="v">security-review</span>
            {")\n        - "}
            <span className="t">skill</span>
            {"("}
            <span className="v">perf-review</span>
            {")\n        - "}
            <span className="t">skill</span>
            {"("}
            <span className="v">ai-slop-detection</span>
            {")\n        - "}
            <span className="t">skill</span>
            {"("}
            <span className="v">training-pollution-audit</span>
            {")\n        - "}
            <span className="t">skill</span>
            {"("}
            <span className="v">test-coverage-review</span>
            {")\n    - "}
            <span className="t">await_all</span>
            {"\n    - "}
            <span className="t">skill</span>
            {"("}
            <span className="v">synthesize-findings</span>
            {")"}
          </pre>
        </Card>
      </div>

      <Card style={{ marginBottom: 20 }}>
        <h4 style={{ marginBottom: 14 }}>Consensus Analysis Output</h4>
        <p
          style={{ fontSize: 12, color: "var(--mid)", marginBottom: 12 }}
        >
          5 independent agents reviewed the same PR. Here's where they agreed
          and diverged:
        </p>
        <ScoreBar
          label="auth token validation"
          percent={100}
          level="low"
          value="5/5 flagged"
          labelWidth={180}
        />
        <ScoreBar
          label="missing rate limiting"
          percent={80}
          level="low"
          value="4/5 flagged"
          labelWidth={180}
        />
        <ScoreBar
          label="error msg too verbose"
          percent={60}
          level="mid"
          value="3/5 flagged"
          labelWidth={180}
        />
        <ScoreBar
          label="naming inconsistency"
          percent={40}
          level="mid"
          value="2/5 flagged"
          labelWidth={180}
        />
        <ScoreBar
          label="unnecessary abstraction"
          percent={20}
          level="high"
          value="1/5 flagged"
          labelWidth={180}
        />
        <div
          style={{
            marginTop: 14,
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <Pill variant="red">2 high-confidence issues</Pill>
          <Pill variant="amber">1 likely issue</Pill>
          <Pill variant="dim">2 ambiguous — human judgment needed</Pill>
        </div>
      </Card>

      <div className="g2">
        <Card accent="green">
          <h4>Every context is a readable chat</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            This isn't a black box vote. Each of the N agents is a full
            conversation in the chat tree. You can click into any individual
            reviewer and read their complete reasoning. See exactly why agent #3
            flagged the rate limiting issue but agent #5 didn't. The legible
            history is what makes the divergence actionable.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Configurable in the workflow builder</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Parallel analysis is a node type in the DAG. Set the number of
            contexts, whether prompts are identical or varied, which skills each
            context runs, and what the synthesis step does with the results. Wire
            it into any point in your pipeline. Pre-implementation for path
            analysis. Post-implementation for review. Pre-merge for final
            validation.
          </p>
        </Card>
      </div>
    </div>
  );
}
