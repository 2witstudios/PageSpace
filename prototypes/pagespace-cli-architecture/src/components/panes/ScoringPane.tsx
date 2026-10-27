import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import { ScoreBar } from "../ui/ScoreBar";
import { Pill } from "../ui/Pill";

export function ScoringPane() {
  return (
    <div className="pane">
      <div className="sl">Scoring System</div>
      <h2>
        Quality is <span className="hl">scored, not boolean.</span>{" "}
        <StatusBadge variant="planned" />
      </h2>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        Scoring is not automatic on every change. It's an action you wire up in
        the event system — triggered when you want it, on the mutations you care
        about. But when you do score, it's structured. Every plan can carry a{" "}
        <strong>rubric</strong> with weighted dimensions and minimum thresholds.
        The independent review agent scores each dimension separately, producing
        a detailed quality profile instead of a binary stamp.
      </p>

      <div className="g2" style={{ marginBottom: 24 }}>
        <Card accent="violet">
          <h4 style={{ marginBottom: 12 }}>Rubric (on the plan)</h4>
          <pre>
            <span className="k">rubric</span>
            {":\n  "}
            <span className="t">dimensions</span>
            {":\n    - name: "}
            <span className="s">correctness</span>
            {"\n      weight: "}
            <span className="v">0.30</span>
            {",  gate: "}
            <span className="v">8</span>
            {"\n    - name: "}
            <span className="s">test_coverage</span>
            {"\n      weight: "}
            <span className="v">0.20</span>
            {",  gate: "}
            <span className="v">7</span>
            {"\n    - name: "}
            <span className="s">error_handling</span>
            {"\n      weight: "}
            <span className="v">0.20</span>
            {",  gate: "}
            <span className="v">7</span>
            {"\n    - name: "}
            <span className="s">scope_discipline</span>
            {"\n      weight: "}
            <span className="v">0.15</span>
            {",  gate: "}
            <span className="v">6</span>
            {"\n    - name: "}
            <span className="s">code_style</span>
            {"\n      weight: "}
            <span className="v">0.15</span>
            {",  gate: "}
            <span className="v">5</span>
          </pre>
        </Card>
        <Card accent="cyan">
          <h4 style={{ marginBottom: 12 }}>Rating (from review agent)</h4>
          <pre>
            <span className="k">rating</span>
            {":\n  "}
            <span className="t">scores</span>
            {":\n    correctness:      "}
            <span className="s">9</span>
            {"\n    test_coverage:    "}
            <span className="s">8</span>
            {"\n    error_handling:   "}
            <span className="e">6</span>
            {"  "}
            <span className="c"># below gate</span>
            {"\n    scope_discipline: "}
            <span className="s">8</span>
            {"\n    code_style:       "}
            <span className="s">7</span>
            {"\n  "}
            <span className="t">weighted_total</span>
            {": "}
            <span className="v">7.65</span>
            {"\n  "}
            <span className="t">gate_failures</span>
            {":  ["}
            <span className="e">error_handling</span>
            {"]\n  "}
            <span className="t">verdict</span>
            {":        "}
            <span className="e">partial_pass</span>
          </pre>
        </Card>
      </div>

      <Card style={{ marginBottom: 24 }}>
        <h4 style={{ marginBottom: 14 }}>Example Review Score</h4>
        <ScoreBar
          label="correctness"
          percent={90}
          level="high"
          value="9"
        />
        <ScoreBar
          label="test_coverage"
          percent={80}
          level="high"
          value="8"
        />
        <ScoreBar
          label="error_handling"
          percent={60}
          level="low"
          value="6"
        />
        <ScoreBar
          label="scope_discipline"
          percent={80}
          level="high"
          value="8"
        />
        <ScoreBar
          label="code_style"
          percent={70}
          level="high"
          value="7"
        />
        <div
          style={{
            marginTop: 14,
            display: "flex",
            gap: 10,
          }}
        >
          <Pill variant="amber">7.65 weighted</Pill>
          <Pill variant="red">error_handling below gate</Pill>
          <Pill variant="red">partial_pass</Pill>
        </div>
      </Card>

      <div className="g3">
        <Card accent="green">
          <h4>Pass</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            All dimensions above gate. Code accepted. Next task.
          </p>
        </Card>
        <Card accent="amber">
          <h4>Partial</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Some dimensions fell short. Targeted fix scoped to failures only.
          </p>
        </Card>
        <Card accent="red">
          <h4>Fail</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Below threshold. Fresh attempt. History preserved.
          </p>
        </Card>
      </div>
    </div>
  );
}
