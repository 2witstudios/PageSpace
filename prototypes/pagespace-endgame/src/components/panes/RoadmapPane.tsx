import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import { Pill } from "../ui/Pill";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";

export function RoadmapPane() {
  return (
    <div className="pane">
      <div className="sl">Build Plan</div>
      <h2>
        Five phases.{" "}
        <span className="hl">Decision gate first.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        Phase 1 is a decision gate &mdash; define the API contract between
        the runtime service and the rest of PageSpace. Everything after that
        depends on this contract being right.
      </p>

      <ArchDiagram>
        <ArchRow label="Phase 1" labelSub="6-8 weeks" style={{ marginBottom: 8 }}>
          <ArchNode
            title="IDE / Coder Interface"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.4)"
            style={{ border: "2px solid rgba(34,211,238,0.4)" }}
            status={<StatusBadge variant="planned" />}
            detail="THE UNLOCK &mdash; IDE enables CMS enables CRM<br>Terminal integration (xterm.js) in PageSpace UI<br>Git clone/branch/commit/push from within PageSpace<br>File browser mapping repo contents to page tree"
          />
          <ArchNode
            title="Container Hierarchy"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Drive = container + Postgres<br>Repo = container (git repo within drive)<br>Branch = container (Firecracker/Docker)<br>BRANCH page type + provisioning"
          />
        </ArchRow>

        <ArchConnector text="IDE running &mdash; pages become deployable" />

        <ArchRow label="Phase 2" labelSub="6-8 weeks" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Runtime Service"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Create apps/runtime/ in monorepo<br>Agent loop: task &rarr; LLM &rarr; tools &rarr; evaluate<br>Basic scheduling (cron + event triggers)<br>Service-to-service auth with web app"
          />
          <ArchNode
            title="Schema Extensions"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Shared Drizzle schema for agent state<br>Extend pages + conversations tables<br>Wire into Socket.IO for streaming<br>Single database, shared types"
          />
        </ArchRow>

        <ArchConnector text="runtime running &mdash; agents can execute autonomously" />

        <ArchRow label="Phase 3" labelSub="4-6 weeks" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Memory + Entity State"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Turso/SQLite sync to containers<br>Scoped agent memory (context/task/plan/global)<br>Plan, Task, Mutation, Rating, TurnLog tables<br>Enhanced search: semantic + knowledge graph"
          />
        </ArchRow>

        <ArchConnector text="memory + traceability &mdash; agents can learn" />

        <ArchRow label="Phase 4" labelSub="4-6 weeks" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Workflows + Skills"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Workflow orchestration: fan-out/gates/retry<br>Visual workflow builder UI<br>Pages-as-skills: catalog, discovery<br>Trigger engine: code/agent/system events"
          />
        </ArchRow>

        <ArchConnector text="full orchestration &mdash; agents can coordinate" />

        <ArchRow label="Phase 5" labelSub="4-6 weeks">
          <ArchNode
            title="CMS + CRM"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="CMS: pages as publishable content<br>Drive = website repo with build pipeline<br>Publishing workflows + content scheduling<br>CRM emerges from CMS + agents + workflows"
          />
          <ArchNode
            title="Advanced Features"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Firecracker migration (from Docker)<br>Cross-agent search + analytics<br>Channel adapters (Slack, Discord, etc.)<br>MCP server endpoint"
          />
        </ArchRow>
      </ArchDiagram>

      <hr />

      <div className="sl">Key Files</div>
      <h2>
        Where the code{" "}
        <span className="hl">goes.</span>
      </h2>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>Schema</h4>
          <p style={{ marginTop: 6, fontSize: 12, fontFamily: "var(--mono)", lineHeight: 2 }}>
            <Pill variant="green">live</Pill> packages/db/src/schema/core.ts<br />
            <span style={{ color: "var(--dim)", fontSize: 10 }}>add BRANCH to pageType enum</span><br />
            <Pill variant="blue">new</Pill> packages/db/src/schema/runtime.ts<br />
            <span style={{ color: "var(--dim)", fontSize: 10 }}>agent state, scheduling, workflow tables</span><br />
            <Pill variant="blue">new</Pill> packages/db/src/schema/entity-state.ts<br />
            <span style={{ color: "var(--dim)", fontSize: 10 }}>Plan, Task, Mutation, Rating, TurnLog</span>
          </p>
        </Card>
        <Card accent="blue">
          <h4>Runtime Service</h4>
          <p style={{ marginTop: 6, fontSize: 12, fontFamily: "var(--mono)", lineHeight: 2 }}>
            <Pill variant="blue">new</Pill> apps/runtime/<br />
            <span style={{ color: "var(--dim)", fontSize: 10 }}>entire service: agent loop, scheduling, workflows</span><br />
            <Pill variant="blue">new</Pill> apps/runtime/src/agent-loop.ts<br />
            <span style={{ color: "var(--dim)", fontSize: 10 }}>core execution cycle</span><br />
            <Pill variant="blue">new</Pill> apps/runtime/src/scheduler.ts<br />
            <span style={{ color: "var(--dim)", fontSize: 10 }}>cron + triggers</span><br />
            <Pill variant="blue">new</Pill> apps/runtime/src/workflow-engine.ts<br />
            <span style={{ color: "var(--dim)", fontSize: 10 }}>DAG execution</span>
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 24 }}>
        <Card accent="violet">
          <h4>Integration</h4>
          <p style={{ marginTop: 6, fontSize: 12, fontFamily: "var(--mono)", lineHeight: 2 }}>
            <Pill variant="blue">new</Pill> packages/lib/src/services/runtime-client.ts<br />
            <span style={{ color: "var(--dim)", fontSize: 10 }}>web app &rarr; runtime communication</span><br />
            <Pill variant="green">edit</Pill> apps/control-plane/src/services/provisioning-engine.ts<br />
            <span style={{ color: "var(--dim)", fontSize: 10 }}>extend for Firecracker/runtime provisioning</span>
          </p>
        </Card>
        <Card accent="cyan">
          <h4>Web App</h4>
          <p style={{ marginTop: 6, fontSize: 12, fontFamily: "var(--mono)", lineHeight: 2 }}>
            <Pill variant="blue">new</Pill> apps/web/src/app/(workspace)/branch/<br />
            <span style={{ color: "var(--dim)", fontSize: 10 }}>BRANCH page type UI</span><br />
            <Pill variant="blue">new</Pill> apps/web/src/app/(workspace)/dashboard/<br />
            <span style={{ color: "var(--dim)", fontSize: 10 }}>agent monitoring dashboard</span><br />
            <Pill variant="blue">new</Pill> apps/web/src/app/(workspace)/workflows/<br />
            <span style={{ color: "var(--dim)", fontSize: 10 }}>visual workflow builder</span>
          </p>
        </Card>
      </div>

      <hr />

      <div className="sl">Verification</div>
      <h2>
        How we know{" "}
        <span className="hl">it's working.</span>
      </h2>

      <div className="g2">
        <Card accent="green">
          <h4>After Phase 1</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            The team can look at the architecture and immediately understand
            the vision and where every capability lives. Every
            capability has a clear home. No duplication.
          </p>
        </Card>
        <Card accent="blue">
          <h4>After Phase 2</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            An agent can be created as a page, receive a task, call an LLM,
            execute tools, and return results. Output streams to the browser.
            Basic scheduling works (cron).
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginTop: 12 }}>
        <Card accent="cyan">
          <h4>After Phase 3</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Creating a BRANCH page spins up a container. Agents inside can
            read/write PageSpace pages. Local Turso/SQLite for fast memory.
            Deleting the page destroys the container.
          </p>
        </Card>
        <Card accent="violet">
          <h4>After Phase 5</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Multiple ICP interfaces serve different user types from the same
            backend. Agents coordinate across interfaces. The system generates
            new interfaces when needed.
          </p>
        </Card>
      </div>
    </div>
  );
}
