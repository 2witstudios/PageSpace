import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function WorkspacePane() {
  return (
    <div className="pane">
      <div className="sl">Interface</div>
      <h2>
        PageSpace is the interface.{" "}
        <span className="hl">No separate app.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        Orchestration features surface inside PageSpace's existing web UI. The
        page tree is already a sidebar. Drives are already navigable. AI_CHAT
        pages already have conversations. The new work is extending PageSpace to
        show agent status, container health, and branch-level organization —
        not building a second application.
      </p>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        Humans use the PageSpace web UI to manage and observe agents. Humans (or
        agents) use the Pagespace CLI from a terminal. Both hit the same API
        surface, same auth, same permissions.
      </p>

      <div className="sl">Agent Management in PageSpace</div>
      <div className="g3" style={{ marginBottom: 24 }}>
        <Card accent="green">
          <h4>AI_CHAT Pages = Agent Config</h4>
          <p style={{ fontSize: 12, marginTop: 6, lineHeight: 1.8 }}>
            Each AI_CHAT page IS an agent definition. System prompt, model,
            enabled tools, agent definition. Configure agents the same way you
            configure any page. When parented under a BRANCH page, the agent
            runs in that branch's container.
          </p>
        </Card>
        <Card accent="violet">
          <h4>
            BRANCH Pages = Containers <StatusBadge variant="planned" />
          </h4>
          <p style={{ fontSize: 12, marginTop: 6, lineHeight: 1.8 }}>
            New page type in the sidebar. Create one, get a cloud container with
            that git branch checked out. Child pages (agents, docs, tasks)
            inherit the branch context. Collapsible in the sidebar — shows
            agent count badge when collapsed.
          </p>
        </Card>
        <Card accent="cyan">
          <h4>Drive = Repo Scope</h4>
          <p style={{ fontSize: 12, marginTop: 6, lineHeight: 1.8 }}>
            One drive per codebase. Drive members = team with RBAC. Drive
            prompt = project-level AI context. Skills, plans, and branch pages
            all live in the same tree with permissions cascading naturally.
          </p>
        </Card>
      </div>

      <div className="sl">Observability</div>
      <FeatureRow columns={4} style={{ marginBottom: 24 }}>
        <Feature
          nameColor="var(--green)"
          name="Agent Status"
          status={<StatusBadge variant="planned" />}
          description="See which agents are running, idle, or failed. Live updates via Socket.IO. Status badges on AI_CHAT pages in the sidebar."
          style={{ padding: "18px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Task Progress"
          description="TASK_LIST pages track plan execution. View progress, blockers, completions. Agents update tasks via CLI from inside containers."
          style={{ padding: "18px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--violet)"
          name="Conversation History"
          description="Every agent interaction is a conversation. Full message history, tool call logs, context windows. Browse and search through existing PageSpace UI."
          style={{ padding: "18px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Skill Catalog"
          description="Document/Code pages as skills. Browse, search, version-track skill definitions. Agents load skills via CLI before executing."
          style={{ padding: "18px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <div className="sl">Convergence</div>
      <p style={{ marginBottom: 16, maxWidth: 720 }}>
        Three interfaces to the same system. Same auth, same data, same
        permissions.
      </p>
      <div className="g3" style={{ marginBottom: 12 }}>
        <Card style={{ borderLeft: "3px solid var(--green)" }}>
          <h4 style={{ marginBottom: 10 }}>PageSpace Web UI</h4>
          <p
            style={{
              fontSize: 12,
              fontFamily: "var(--mono)",
              lineHeight: 2,
            }}
          >
            Drive navigation
            <br />
            BRANCH pages (container status)
            <br />
            AI_CHAT pages (agent config)
            <br />
            Conversation viewer
            <br />
            Skill editor
            <br />
            Task tracking
          </p>
        </Card>
        <Card style={{ borderLeft: "3px solid var(--blue)" }}>
          <h4 style={{ marginBottom: 10 }}>Container (Agent's View)</h4>
          <p
            style={{
              fontSize: 12,
              fontFamily: "var(--mono)",
              lineHeight: 2,
            }}
          >
            Real filesystem + git
            <br />
            Shell (bash, zsh)
            <br />
            Pagespace CLI installed
            <br />
            npm / cargo / python
            <br />
            Agent loop execution
            <br />
            Full autonomy
          </p>
        </Card>
        <Card style={{ borderLeft: "3px solid var(--cyan)" }}>
          <h4 style={{ marginBottom: 10 }}>Human CLI</h4>
          <p
            style={{
              fontSize: 12,
              fontFamily: "var(--mono)",
              lineHeight: 2,
            }}
          >
            ps page read/write
            <br />
            ps search
            <br />
            ps agent ask/status
            <br />
            ps task update
            <br />
            ps memory read/write
            <br />
            Browser OAuth
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginTop: 12 }}>
        <Card accent="green">
          <h4>What PageSpace already handles</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Page editing, AI conversations, drive navigation, permissions,
            version history, file uploads, channels, notifications, task
            management, workflow scheduling, integrations. All live.
          </p>
        </Card>
        <Card accent="blue">
          <h4>What gets added</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            BRANCH page type with container backing. Agent status indicators in
            the sidebar. Container health views. The Pagespace CLI for terminal
            access. Orchestration features (loops, gates, swarms) managed
            through the existing page/workflow model.
          </p>
        </Card>
      </div>
    </div>
  );
}
