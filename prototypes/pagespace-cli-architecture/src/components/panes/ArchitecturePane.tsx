import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";
import { DataTable } from "../ui/DataTable";
import { FeatureRow, Feature } from "../ui/FeatureRow";

/* ── Integration mapping row ── */
const td: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid rgba(42,42,61,0.5)",
  verticalAlign: "top",
  fontSize: 12,
};

function MapRow({
  subsystem,
  existsAs,
  cliRole,
  live,
}: {
  subsystem: string;
  existsAs: string;
  cliRole: string;
  live?: boolean;
}) {
  return (
    <tr>
      <td
        style={{
          ...td,
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--amber)",
          fontWeight: 600,
        }}
      >
        {subsystem}
      </td>
      <td style={{ ...td, color: "var(--mid)" }}>{existsAs}</td>
      <td style={{ ...td, color: "var(--cyan)", fontWeight: 600 }}>
        {cliRole}
      </td>
      <td style={td}>
        <StatusBadge variant={live !== false ? "live" : "planned"} />
      </td>
    </tr>
  );
}

export function ArchitecturePane() {
  return (
    <div className="pane">
      {/* ═══════ Section 1: The Model ═══════ */}
      <div className="sl">System Architecture</div>
      <h2>
        PageSpace is the platform. Containers are execution.{" "}
        <span className="hl">The CLI is the bridge.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        PageSpace is not a backend. It is the interface — where humans and
        agents collaborate, where memory persists, where skills are defined,
        where permissions are enforced. It already has 10 page types, drives
        with RBAC, multi-provider AI, workflows with cron, real-time sync,
        integrations, and 251 API endpoints.
      </p>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        What's new is a <strong>BRANCH page type</strong> backed by a cloud
        container with a real filesystem. When you create a BRANCH page, a
        container spins up with that branch checked out. AI_CHAT pages created
        under that branch are agents running in that container — with full shell
        access, git, compilers, test runners, and the Pagespace CLI.
      </p>
      <p style={{ marginBottom: 24, maxWidth: 720 }}>
        The <strong>Pagespace CLI</strong> is installed in every container. It's
        how agents access PageSpace from the shell — read pages, search context,
        update tasks, invoke other agents, persist memory. Agents in shells are
        more powerful because they get shell power{" "}
        <strong>plus</strong> PageSpace access. Humans can use the same CLI from
        their own terminal.
      </p>

      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 28,
        }}
      >
        <StatusBadge variant="live" />
        <span style={{ fontSize: 12, color: "var(--mid)" }}>
          exists in PageSpace today
        </span>
        <StatusBadge variant="planned" />
        <span style={{ fontSize: 12, color: "var(--mid)" }}>
          new capability
        </span>
      </div>

      {/* ═══════ Section 2: The Page Tree Model ═══════ */}
      <div className="sl">The Page Tree as Workspace</div>
      <h3>
        Drive = repo. Branch = container.{" "}
        <span style={{ color: "var(--blue)" }}>Children inherit context.</span>
      </h3>
      <p style={{ marginBottom: 16, maxWidth: 720 }}>
        PageSpace's page tree already provides hierarchy, permissions, and
        context flow. With the BRANCH page type, it becomes a workspace:
      </p>

      <Card style={{ marginBottom: 24, padding: "20px 24px" }}>
        <pre>
          <span className="t">Drive</span>
          {" (repo: org/api-server)\n"}
          {"├── "}
          <span className="k">main</span>
          {" ("}
          <span className="e">BRANCH</span>
          {" → container)\n"}
          {"│   ├── code-review-agent ("}
          <span className="s">AI_CHAT</span>
          {")\n"}
          {"│   └── test-runner ("}
          <span className="s">AI_CHAT</span>
          {")\n"}
          {"├── "}
          <span className="k">feature/billing</span>
          {" ("}
          <span className="e">BRANCH</span>
          {" → container)\n"}
          {"│   ├── implementation-agent ("}
          <span className="s">AI_CHAT</span>
          {")\n"}
          {"│   ├── sub-task-agent ("}
          <span className="s">AI_CHAT</span>
          {")\n"}
          {"│   └── notes.md ("}
          <span className="c">DOCUMENT</span>
          {")\n"}
          {"├── Skills/ ("}
          <span className="c">FOLDER</span>
          {")\n"}
          {"│   ├── review-prompt ("}
          <span className="c">DOCUMENT</span>
          {")\n"}
          {"│   └── test-gen ("}
          <span className="c">CODE</span>
          {")\n"}
          {"└── plan.md ("}
          <span className="c">DOCUMENT</span>
          {")"}
        </pre>
      </Card>

      <div className="g3" style={{ marginBottom: 24 }}>
        <Card accent="green">
          <h4>Drive = Repo</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            One drive per codebase. RBAC at the drive level controls who can see
            and modify the project. Drive prompt sets project-level AI context.
            All existing drive features (members, roles, permissions) apply.
          </p>
        </Card>
        <Card accent="blue">
          <h4>
            BRANCH = Container <StatusBadge variant="planned" />
          </h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            New page type. When created, spins up a cloud container with that
            branch checked out. Real filesystem, real git, real shell. The
            Pagespace CLI is pre-installed. Destroying the page destroys the
            container.
          </p>
        </Card>
        <Card accent="violet">
          <h4>AI_CHAT under BRANCH = Agent</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            AI_CHAT pages created as children of a BRANCH page run their agent
            in that branch's container. They inherit the branch context — the
            codebase, the filesystem, the shell. Like PurePoint: children go
            into that branch.
          </p>
        </Card>
      </div>

      {/* ═══════ Section 3: Three Layers ═══════ */}
      <hr />
      <div className="sl">Three Layers</div>
      <h2>
        PageSpace. Containers. CLI.{" "}
        <span className="hl">How they connect.</span>
      </h2>

      <ArchDiagram>
        <ArchRow label="PageSpace" labelSub="interface + memory" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Agent Definitions"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="live" />}
            detail="AI_CHAT pages: system prompt, model, tools<br>agentDefinition &middot; visibleToGlobalAssistant<br>Agents are pages, not containers<br>Used for regular chat AND orchestration"
          />
          <ArchNode
            title="Skills &amp; Plans"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Document/Code pages = skill definitions<br>Instructions, prompts, templates<br>Not the codebase &mdash; real code is in git<br>Version-tracked via page versions"
          />
          <ArchNode
            title="Memory &amp; History"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Conversations: global, page, drive scoped<br>Message history + tool call logs<br>Task lists for plan tracking<br>Channels for agent notifications"
          />
          <ArchNode
            title="Organization"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Drives = project/repo scope<br>RBAC: owner/admin/member + custom roles<br>Page permissions: view/edit/share/delete<br>Workflows + cron + event triggers"
          />
        </ArchRow>

        <ArchConnector text="BRANCH pages create containers &middot; AI_CHAT children run inside them" />

        <ArchRow label="Containers" labelSub="execution" style={{ marginBottom: 8 }}>
          <ArchNode
            title="BRANCH Page Type"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="New page type backed by cloud container<br>Create page &rarr; spin up container<br>Branch checked out on real filesystem<br>Delete page &rarr; destroy container"
          />
          <ArchNode
            title="Shell Environment"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Real terminal, env vars, dependencies<br>git, npm, cargo, python &mdash; whatever is needed<br>Multiple agent processes per container<br>Isolated filesystem per branch"
          />
          <ArchNode
            title="Agent Execution"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="AI_CHAT children of BRANCH run here<br>Full shell access + Pagespace CLI<br>Plan &rarr; execute &rarr; evaluate &rarr; loop<br>Sub-agents as nested AI_CHAT pages"
          />
        </ArchRow>

        <ArchConnector text="agents in containers use CLI to access PageSpace" />

        <ArchRow label="CLI" labelSub="the bridge">
          <ArchNode
            title="Pagespace CLI"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Installed in every container<br>ps page read &middot; ps search &middot; ps task update<br>ps agent ask &middot; ps memory write<br>Token auth (agents) &middot; OAuth (humans)"
          />
          <ArchNode
            title="Why CLI"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.3)"
            style={{ background: "transparent" }}
            detail="Agents in shells are more powerful<br>Shell power + PageSpace access<br>Composable &middot; pipeable &middot; no SDK required<br>Any process can call it &mdash; human or agent"
          />
          <ArchNode
            title="For Humans Too"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.3)"
            detail="Same commands from your own terminal<br>Browser OAuth for authentication<br>Manage agents, search, read pages<br>Without opening the web UI"
          />
        </ArchRow>
      </ArchDiagram>

      {/* ═══════ Section 4: PageSpace Surface Area ═══════ */}
      <hr />
      <div className="sl">PageSpace Surface Area</div>
      <h3>
        Everything the platform already provides &mdash;{" "}
        <span style={{ color: "var(--green)" }}>all live.</span>
      </h3>

      <ArchDiagram>
        <ArchRow label="Auth &amp; Security" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Authentication"
            titleColor="var(--red)"
            borderColor="rgba(255,77,106,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Magic Link &middot; Passkeys (WebAuthn)<br>OAuth (Google/Apple) &middot; Password<br>Opaque session tokens (SHA-256)<br>CSRF &middot; rate limiting &middot; account lockout"
          />
          <ArchNode
            title="Tokens"
            titleColor="var(--red)"
            borderColor="rgba(255,77,106,0.3)"
            status={<StatusBadge variant="live" />}
            detail="ps_sess_* (sessions) &middot; ps_mcp_* (API)<br>ps_dev_* (devices) &middot; ps_sock_* (sockets)<br>7-day TTL &middot; HIPAA idle timeout<br>Instant revocation &middot; never plaintext"
          />
          <ArchNode
            title="RBAC"
            titleColor="var(--red)"
            borderColor="rgba(255,77,106,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Drive: OWNER, ADMIN, MEMBER + custom<br>Page: canView/canEdit/canShare/canDelete<br>L1 + L2 Redis cache<br>Zero-trust permission mutations"
          />
        </ArchRow>

        <ArchConnector text="auth &middot; permissions &middot; content" />

        <ArchRow label="Pages &amp; AI" style={{ marginBottom: 8 }}>
          <ArchNode
            title="10 Page Types"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="live" />}
            detail="FOLDER &middot; DOCUMENT &middot; CHANNEL &middot; AI_CHAT<br>CANVAS &middot; FILE &middot; SHEET &middot; TASK_LIST<br>CODE &middot; TERMINAL<br>+ BRANCH (planned)"
          />
          <ArchNode
            title="Multi-Provider AI"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            status={<StatusBadge variant="live" />}
            detail="11 providers &middot; 100+ models<br>Per-conversation model selection<br>Encrypted API keys per user<br>Streaming responses"
          />
          <ArchNode
            title="20+ Tools"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Page CRUD &middot; search &middot; task management<br>Agent-to-agent (ask_agent + depth tracking)<br>Tool roles: PARTNER, PLANNER, WRITER<br>Activity logging with full attribution"
          />
          <ArchNode
            title="Conversations"
            titleColor="var(--violet)"
            borderColor="rgba(167,139,250,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Global &middot; page-scoped &middot; drive-scoped<br>Tool call + result logs<br>Version history &middot; 30-day retention<br>Drive backups with full snapshots"
          />
        </ArchRow>

        <ArchConnector text="real-time &middot; automation &middot; integrations" />

        <ArchRow label="Platform" style={{ marginBottom: 8 }}>
          <ArchNode
            title="Socket.IO"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.3)"
            status={<StatusBadge variant="live" />}
            detail="Room-based: pages, drives, DMs<br>Permission-gated joins &middot; per-event reauth<br>Presence tracking &middot; broadcast API<br>Kick API for revocation"
          />
          <ArchNode
            title="Workflows + Cron"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            status={<StatusBadge variant="live" />}
            detail="cronExpression &middot; timezone &middot; nextRunAt<br>Event triggers &middot; folder watches &middot; debounce<br>Links agent pages to trigger conditions<br>Status tracking: success/error/running"
          />
          <ArchNode
            title="Integrations"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            status={<StatusBadge variant="live" />}
            detail="GitHub &middot; Slack &middot; Notion &middot; Webhook<br>Encrypted credentials &middot; OAuth state<br>Grants linking connections to agents<br>Audit logs for all executions"
          />
          <ArchNode
            title="Infrastructure"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="live" />}
            detail="PostgreSQL &middot; Redis &middot; S3<br>Control plane: provisioning &middot; lifecycle<br>3 deployment modes (cloud/onprem/tenant)<br>251 API endpoints"
          />
        </ArchRow>
      </ArchDiagram>

      {/* ═══════ Section 5: Integration Mapping ═══════ */}
      <hr />
      <div className="sl">How It All Maps</div>
      <h2>
        Every subsystem has a role in the{" "}
        <span className="hl">agent workflow.</span>
      </h2>

      <Card style={{ overflow: "auto", marginBottom: 20, padding: 0 }}>
        <DataTable
          headers={["PageSpace Subsystem", "What It Is Today", "Role in Agent Workflows", ""]}
        >
          <MapRow
            subsystem="AI_CHAT Pages"
            existsAs="System prompt, enabled tools, model config, agent definition"
            cliRole="Agent Definitions (not containers)"
          />
          <MapRow
            subsystem="BRANCH Pages"
            existsAs="New page type"
            cliRole="Container-backed execution environments"
            live={false}
          />
          <MapRow
            subsystem="Document/Code Pages"
            existsAs="Rich text + code editor with versioning"
            cliRole="Skill definitions (instructions, not codebase)"
          />
          <MapRow
            subsystem="Drives"
            existsAs="Organizational scope with RBAC"
            cliRole="Repo scope — one drive per codebase"
          />
          <MapRow
            subsystem="Page Tree"
            existsAs="Nested hierarchy with parent references"
            cliRole="Workspace structure — branch children inherit context"
          />
          <MapRow
            subsystem="RBAC + Permissions"
            existsAs="canView/canEdit/canShare/canDelete per user per page"
            cliRole="Agent permission boundaries"
          />
          <MapRow
            subsystem="Auth (Opaque Tokens)"
            existsAs="ps_sess_*, SHA-256 hashed, instant revocation"
            cliRole="CLI auth — tokens for agents, OAuth for humans"
          />
          <MapRow
            subsystem="Workflows Table"
            existsAs="cronExpression, timezone, agentPageId, contextPageIds"
            cliRole="Cron / scheduling layer for agents"
          />
          <MapRow
            subsystem="Event Triggers"
            existsAs="triggerType, watchedFolderIds, eventDebounceSecs"
            cliRole="Agent event system"
          />
          <MapRow
            subsystem="Socket.IO"
            existsAs="Room-based, permission-gated, broadcast API"
            cliRole="Agent streaming + real-time status"
          />
          <MapRow
            subsystem="Page Versions"
            existsAs="30-day retention, pinnable, source tracking"
            cliRole="Skill versioning + context snapshots"
          />
          <MapRow
            subsystem="Integrations"
            existsAs="GitHub, Slack, Notion, webhook providers"
            cliRole="External tool access for agents"
          />
          <MapRow
            subsystem="Conversations"
            existsAs="Global, page-scoped, drive-scoped history"
            cliRole="Agent conversation memory"
          />
          <MapRow
            subsystem="ask_agent Tool"
            existsAs="Agent-to-agent with call depth tracking"
            cliRole="Sub-agent delegation"
          />
          <MapRow
            subsystem="Task Lists"
            existsAs="TASK_LIST page type with todo management"
            cliRole="Plan decomposition + progress tracking"
          />
          <MapRow
            subsystem="Channels"
            existsAs="Real-time messaging with reactions"
            cliRole="Agent notification + collaboration"
          />
          <MapRow
            subsystem="Pagespace CLI"
            existsAs="New CLI tool"
            cliRole="Bridge — agents in containers access PageSpace"
            live={false}
          />
        </DataTable>
      </Card>

      <Card accent="green" style={{ marginBottom: 12 }}>
        <h4>Almost everything already exists</h4>
        <p style={{ marginTop: 6, fontSize: 12 }}>
          15 of 17 subsystems are live in production today. The only new
          infrastructure is the BRANCH page type (containers) and the Pagespace
          CLI (the bridge). Everything else is wiring existing capabilities into
          agent workflows.
        </p>
      </Card>

      {/* ═══════ Section 6: What's New ═══════ */}
      <hr />
      <div className="sl">What's New</div>
      <h2>
        BRANCH pages, the CLI, and the{" "}
        <span className="hl">orchestration loop.</span>
      </h2>

      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--blue)"
          name="BRANCH Page Type"
          description="New page type backed by a cloud container. Create the page, get a real filesystem with that branch checked out. Child AI_CHAT pages run agents inside it."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--cyan)"
          name="Pagespace CLI"
          description="Installed in every container. Agents call ps page/search/task/agent/memory to access PageSpace. Token auth for agents, browser OAuth for humans."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--violet)"
          name="Agent Loop"
          description="Plan → execute → evaluate → loop. Replaces single-turn tool calls with real autonomous loops. Gates bound iterations. Sub-agents via nested AI_CHAT pages."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="Orchestration"
          description="Swarm coordination, parallel analysis, scoring rubrics, trigger routing. All built on PageSpace primitives — pages, permissions, workflows, events."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      {/* ═══════ Section 7: Closing ═══════ */}
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="green">
          <h4>PageSpace is the platform</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Not a backend. Not a memory layer. The platform — where humans
            manage agents, view conversations, configure skills, set permissions,
            schedule workflows, and collaborate. The web UI humans already know.
          </p>
        </Card>
        <Card accent="blue">
          <h4>Containers are execution</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Real shells, real filesystems, real git. BRANCH pages in the page
            tree, backed by cloud containers. Agents run here with the CLI as
            their interface to PageSpace. Code stays in git where it belongs.
          </p>
        </Card>
      </div>

      <Card style={{ borderColor: "var(--border2)" }}>
        <h4 style={{ color: "var(--dim)" }}>The principle</h4>
        <p style={{ fontSize: 12, color: "var(--dim)" }}>
          PageSpace's page type system already handles pages that behave
          differently — a CHANNEL is nothing like a DOCUMENT, a FILE is backed
          by S3 not postgres. A BRANCH page backed by a container is the same
          pattern. Same tree, same permissions, same collaboration model.
          Different backing store.
        </p>
      </Card>
    </div>
  );
}
