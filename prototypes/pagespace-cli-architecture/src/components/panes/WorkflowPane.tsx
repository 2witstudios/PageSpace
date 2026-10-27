import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import {
  DagContainer,
  DagRow,
  DagNode,
  DagEdge,
  DagVertical,
} from "../ui/DagDiagram";
import { HorizontalPath, PathStep } from "../ui/HorizontalPath";

export function WorkflowPane() {
  return (
    <div className="pane">
      <div className="sl">Workflow Builder</div>
      <h2>
        Configure your AI pipeline{" "}
        <span className="hl">like a flowchart.</span>{" "}
        <StatusBadge variant="planned" />
      </h2>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        The workflow builder is a visual editor for the event system. Each node
        is a skill or command. Each edge is a trigger with conditions. Drag
        nodes onto the canvas, connect them, configure what context gets loaded
        and what scoring thresholds apply. Not everything needs scoring. Not
        every change needs review. You wire up exactly the workflow you want.
      </p>

      <DagContainer>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--dim)",
            marginBottom: 16,
            textAlign: "center",
          }}
        >
          Plan &rarr; Implement &rarr; Review &rarr; Gate &rarr; Next or Fix
        </div>
        <DagRow>
          <DagNode type="decompose" name="Plan Ingestion" color="amber" />
          <DagEdge />
          <DagNode type="implement" name="Swarm" color="violet" />
          <DagEdge />
          <DagNode type="review" name="Score" color="cyan" />
          <DagEdge />
          <DagNode type="gate" name="Threshold" color="red" />
        </DagRow>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 120,
            margin: "8px 0",
          }}
        >
          <DagVertical label="pass" color="var(--green)" />
          <DagVertical label="partial" color="var(--amber)" />
          <DagVertical label="fail" color="var(--red)" />
        </div>
        <DagRow style={{ justifyContent: "center", gap: 14 }}>
          <DagNode type="advance" name="Next Task" color="green" />
          <DagNode type="fix" name="Targeted Fix" color="amber" />
          <DagNode type="retry" name="Fresh Attempt" color="red" />
        </DagRow>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            margin: "12px 0",
          }}
        >
          <DagVertical label="all complete" />
        </div>
        <DagRow>
          <DagNode
            type="meta"
            name="Coherence"
            color="amber"
            style={{ flex: "none", minWidth: 160 }}
          />
          <DagEdge />
          <DagNode
            type="snapshot"
            name="Release"
            color="green"
            style={{ flex: "none", minWidth: 160 }}
          />
        </DagRow>
      </DagContainer>

      <div className="g2">
        <Card accent="green">
          <h4>Every node is a chat you can open</h4>
          <p style={{ fontSize: 12, marginTop: 6 }}>
            Click any node to see its full agent conversation. The graph is the
            overview. The chats are the detail.
          </p>
        </Card>
        <Card accent="amber">
          <h4>No code required</h4>
          <p style={{ fontSize: 12, marginTop: 6 }}>
            Non-technical team leads can define review pipelines, quality
            thresholds, and retry policies by wiring up a graph.
          </p>
        </Card>
      </div>

      <hr />
      <div className="sl">
        Happy Path <StatusBadge variant="methodology" />
      </div>
      <h3>
        Plan to release candidate in{" "}
        <span style={{ color: "var(--blue)" }}>one automated flow.</span>
      </h3>
      <p style={{ marginBottom: 24 }}>
        The AIDD methodology defines this workflow today as human-driven prompt
        programs. The target is full automation: every step as an agent in a
        container, every transition as a rule, every artifact as a linked
        entity.
      </p>
      <HorizontalPath>
        <PathStep
          number="01"
          label="Plan"
          note="Write plan with<br>rubric + scope."
          color="amber"
          isFirst
        />
        <PathStep
          number="02"
          label="Decompose"
          note="Break into tasks<br>for parallel work."
          color="amber"
        />
        <PathStep
          number="03"
          label="Swarm"
          note="Spawn agents<br>in containers."
          color="violet"
        />
        <PathStep
          number="04"
          label="Execute"
          note="Write code.<br>Git commit.<br>Mutations tracked."
          color="blue"
        />
        <PathStep
          number="05"
          label="Review"
          note="Score each<br>rubric dimension."
          color="cyan"
        />
        <PathStep
          number="06"
          label="Gate"
          note="Pass / partial /<br>fail. Auto-route."
          color="red"
        />
        <PathStep
          number="07"
          label="Meta"
          note="Cross-plan<br>coherence check."
          color="amber"
        />
        <PathStep
          number="08"
          label="Ship"
          note="Snapshot.<br>Release ready."
          color="green"
          isLast
        />
      </HorizontalPath>
    </div>
  );
}
