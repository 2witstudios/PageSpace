import { Card } from "../ui/Card";
import { StatusBadge } from "../ui/StatusBadge";
import {
  ArchDiagram,
  ArchRow,
  ArchNode,
  ArchConnector,
} from "../ui/ArchDiagram";
import { FeatureRow, Feature } from "../ui/FeatureRow";

export function AgentToolsPane() {
  return (
    <div className="pane">
      {/* ── Current ── */}
      <div className="sl">Current</div>
      <h2>
        40 tools, all loaded upfront,{" "}
        <span className="hl">every single request.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        Today, every AI request ships the full tool schema to the model. The
        Vercel AI SDK&apos;s <code>tool()</code> function defines each tool as a
        Zod schema + execute function, and <code>streamText()</code> receives
        all enabled tools as a static object. Tools are gated per agent via{" "}
        <code>enabledTools</code> config, but the schemas are still compiled at
        build time and bundled into every request&apos;s context window.
      </p>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Adding a new tool means writing TypeScript, defining a Zod schema,
        registering it in the tool module, deploying new code, and restarting.
        Users can&apos;t create tools. Agents can&apos;t discover capabilities
        they weren&apos;t compiled with.
      </p>

      <Card style={{ marginBottom: 24, padding: "20px 24px" }}>
        <pre>
          {"Agent request arrives\n"}
          {"  |\n"}
          {"  v\n"}
          {"Load ALL tool schemas from enabledTools config\n"}
          {"  |\n"}
          {"  v\n"}
          {"Pack 40 tool definitions into LLM context (~8-12k tokens)\n"}
          {"  |\n"}
          {"  v\n"}
          {"LLM picks from the full catalog (or gets confused by it)\n"}
          {"  |\n"}
          {"  v\n"}
          {"Execute tool in Node.js process (no sandbox, no isolation)\n"}
          {"  |\n"}
          {"  v\n"}
          {"Return result -> next step"}
        </pre>
      </Card>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="green">
          <h4>Works well at current scale</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            40 tools across 14 modules is manageable. The LLM handles tool
            selection well enough, schemas are well-typed via Zod, and the{" "}
            <code>enabledTools</code> config provides basic scoping per agent
            type (page agents vs. global assistant vs. nested agents).
          </p>
        </Card>
        <Card accent="amber">
          <h4>But it&apos;s a ceiling</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Every new tool bloats the context window for every request. Tools
            can only be written in TypeScript by developers. No runtime
            composition &mdash; an agent either has a tool at deploy time or
            it doesn&apos;t. No user-authored tools. No marketplace. The
            architecture assumes a small, static tool set.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── The Problem ── */}
      <div className="sl">The Problem</div>
      <h2>
        Schema-upfront is the old way.{" "}
        <span className="hl">It doesn&apos;t scale.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        Packing every tool schema into every request made sense when tools were
        few and simple. But as the tool catalog grows &mdash; and especially
        when users and agents start authoring their own &mdash; the model
        drowns in definitions it doesn&apos;t need. Worse, there&apos;s no way
        for an agent to gain new capabilities without a code deploy.
      </p>

      <FeatureRow columns={4}>
        <Feature
          nameColor="var(--red)"
          name="Context bloat"
          description="40 tool schemas consume ~8&ndash;12k tokens per request. At 100+ tools, that's 25&ndash;30k tokens of boilerplate the model has to parse before it can think. Models get worse at tool selection as the catalog grows."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="Deploy-to-add"
          description="Every new tool requires TypeScript code, Zod schema, module registration, code review, CI, and deployment. Minimum 30 minutes from idea to available tool. No hot-loading, no runtime addition."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--red)"
          name="No user authoring"
          description="Users can't create tools. A team that needs a custom Jira integration or a domain-specific calculator has to request it from us, wait for a release, and hope it fits their workflow."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
        <Feature
          nameColor="var(--amber)"
          name="No runtime composition"
          description="An agent's tool set is fixed at compile time. It can't load a tool mid-conversation based on what it discovers. No dependency resolution, no conditional capabilities."
          style={{ padding: "20px 16px", fontSize: 14 }}
        />
      </FeatureRow>

      <hr />

      {/* ── End Game: Discoverable Skills ── */}
      <div className="sl">End Game</div>
      <h2>
        Discoverable skills,{" "}
        <span className="hl">loaded on demand.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        Instead of dumping every tool schema into the prompt, the agent gets a
        lightweight <strong>skill index</strong> &mdash; names and one-line
        descriptions. When the agent decides it needs a capability, it queries
        the skill registry, pulls the full schema for just that tool, and loads
        it into its working context. The model reasons over a small, relevant
        tool set instead of the entire catalog.
      </p>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        This is how Claude Code, Cursor, and every major agent framework is
        moving. The skill registry becomes the agent&apos;s &ldquo;app
        store&rdquo; &mdash; a searchable catalog of capabilities that can
        grow without degrading performance.
      </p>

      <Card style={{ marginBottom: 24, padding: "20px 24px" }}>
        <pre>
          {"Agent request arrives\n"}
          {"  |\n"}
          {"  v\n"}
          {"Load skill INDEX only (names + descriptions, ~500 tokens)\n"}
          {"  |\n"}
          {"  v\n"}
          {"LLM decides which skills it needs for this task\n"}
          {"  |\n"}
          {"  v\n"}
          {"fetch_skill_schema(skill_id) -> full Zod schema loaded on demand\n"}
          {"  |\n"}
          {"  v\n"}
          {"Execute with full schema in context (only what's needed)\n"}
          {"  |\n"}
          {"  v\n"}
          {"Skills can be: built-in | code page | MCP server | user-authored"}
        </pre>
      </Card>

      <div className="g3" style={{ marginBottom: 12 }}>
        <Card accent="blue">
          <h4>Skill registry</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            A searchable catalog of capabilities with metadata: name,
            description, input/output schema, required permissions, execution
            environment (Node.js, container, MCP), version, and author. Agents
            query it with natural language or tags. Registry resolves
            dependencies between skills automatically.
          </p>
        </Card>
        <Card accent="blue">
          <h4>On-demand schema loading</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            The agent starts with a <code>discover_skills</code> meta-tool that
            searches the registry and a <code>load_skill</code> tool that pulls
            the full schema into context. The model pays the token cost only
            for tools it actually uses. 100+ tools in the catalog, 3&ndash;5
            loaded per request.
          </p>
        </Card>
        <Card accent="green">
          <h4>Hot-deployable</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            New skills register at runtime without restart. A developer pushes
            a skill definition; it&apos;s immediately available to all agents.
            Users author skills through code pages (see below). The registry
            validates schemas and runs compatibility checks on registration.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── Code Execution Tools ── */}
      <div className="sl">Code Execution</div>
      <h2>
        Code pages become tools.{" "}
        <span className="hl">Users write skills.</span>
      </h2>
      <p style={{ marginBottom: 12, maxWidth: 720 }}>
        PageSpace already has a <strong>Code</strong> page type with Monaco
        editor and syntax highlighting. The leap: let users register a code
        page as an executable tool. The page defines its input/output schema
        in a header block, and the runtime executes it in a sandboxed
        container when an agent invokes it.
      </p>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        This is the bridge between &ldquo;knowledge platform&rdquo; and
        &ldquo;agent operating system.&rdquo; Users don&apos;t just store
        code &mdash; they create capabilities that agents can use. A data team
        writes a Python transformation, registers it as a tool, and any agent
        in the workspace can call it. <strong>Requires containerization</strong>{" "}
        from the Runtime roadmap &mdash; code execution must be sandboxed,
        metered, and isolated per tenant.
      </p>

      <div className="g2" style={{ marginBottom: 8 }}>
        <Card accent="violet">
          <h4>Code page as skill definition</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            A code page with a YAML/JSON header block becomes a tool:{" "}
            <code>name</code>, <code>description</code>,{" "}
            <code>inputSchema</code>, <code>outputSchema</code>,{" "}
            <code>language</code> (Python, JS, shell), and{" "}
            <code>permissions</code> (what the tool can access). The code body
            is the implementation. The Monaco editor gets schema validation and
            a &ldquo;Register as Tool&rdquo; button.
          </p>
        </Card>
        <Card accent="violet">
          <h4>Sandboxed execution</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            When an agent calls a code-page tool, the runtime spins up an
            isolated container (or reuses a warm one from the pool), mounts
            the code, passes the input as JSON, and captures stdout as the
            tool result. Execution is metered (CPU time, memory, network) and
            budget-checked against the agent&apos;s limits. Containers are
            per-tenant, no cross-tenant access.
          </p>
        </Card>
      </div>
      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="cyan">
          <h4>Multi-language support</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Container images pre-loaded with Python, Node.js, and shell
            runtimes. Language detection from the code page&apos;s syntax mode.
            Package dependencies declared in the header block and
            cached per workspace. The agent doesn&apos;t care what language
            the tool is written in &mdash; it sees a schema and gets a result.
          </p>
        </Card>
        <Card accent="green">
          <h4>Composable pipelines</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Code-page tools can call other code-page tools via the skill
            registry. A &ldquo;data pipeline&rdquo; is just an agent that
            chains code-page tools together &mdash; extract (Python) &rarr;
            transform (Python) &rarr; load (SQL) &rarr; notify (JS). Each
            step is a user-authored, version-controlled, permissioned tool.
          </p>
        </Card>
      </div>

      <hr />

      {/* ── Architecture ── */}
      <div className="sl">Architecture</div>
      <h2>
        From static tool lists to{" "}
        <span className="hl">a living skill ecosystem.</span>
      </h2>
      <p style={{ marginBottom: 20, maxWidth: 720 }}>
        The skill registry sits between the agent runtime and the execution
        layer. Built-in tools (the existing 40) coexist with code-page tools
        and MCP tools in a single registry. The agent doesn&apos;t know or
        care where a skill lives &mdash; it queries, loads, and calls.
      </p>

      <ArchDiagram>
        <ArchRow label="Agent" labelSub="runtime">
          <ArchNode
            title="Agent Loop"
            titleColor="var(--blue)"
            borderColor="rgba(77,142,255,0.3)"
            status={<StatusBadge variant="live" />}
            detail="streamText() &middot; finish-tool-driven loop<br>Receives skill index at start<br>Calls discover_skills + load_skill as needed<br>Budget-checked per tool invocation"
          />
          <ArchNode
            title="Skill Registry"
            titleColor="var(--violet)"
            borderColor="rgba(139,92,246,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="Searchable catalog &middot; metadata + schemas<br>Dependency resolution &middot; version tracking<br>Permission gating &middot; per-workspace scoping<br>Hot registration &middot; no restart required"
          />
        </ArchRow>
        <ArchConnector text="discover &middot; load &middot; invoke" />
        <ArchRow label="Execution" labelSub="layer">
          <ArchNode
            title="Built-in Tools"
            titleColor="var(--green)"
            borderColor="rgba(61,214,140,0.3)"
            status={<StatusBadge variant="live" />}
            detail="40 existing tools &middot; TypeScript + Zod<br>Page CRUD, search, calendar, agents<br>Run in Node.js process (no sandbox)<br>Migrated to registry as skill entries"
          />
          <ArchNode
            title="Code Page Tools"
            titleColor="var(--cyan)"
            borderColor="rgba(34,211,238,0.3)"
            status={<StatusBadge variant="planned" />}
            detail="User-authored &middot; Python / JS / shell<br>Schema defined in page header block<br>Executed in sandboxed containers<br>Metered &middot; isolated per tenant"
          />
          <ArchNode
            title="MCP Tools"
            titleColor="var(--amber)"
            borderColor="rgba(255,184,77,0.3)"
            status={<StatusBadge variant="live" />}
            detail="External MCP servers &middot; desktop bridge<br>HMAC auth &middot; fingerprinting<br>Registered in skill registry on connect<br>Schemas fetched from MCP protocol"
          />
        </ArchRow>
      </ArchDiagram>

      <div className="g2" style={{ marginBottom: 12 }}>
        <Card accent="blue">
          <h4>Migration path: incremental, not rewrite</h4>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            Existing tools don&apos;t need to change. The registry wraps
            built-in tools with metadata and exposes them alongside code-page
            and MCP tools. Phase 1: registry + discovery for built-in tools.
            Phase 2: code-page registration (requires containers). Phase 3:
            user-facing skill marketplace. Each phase ships independently.
          </p>
        </Card>
        <Card style={{ borderColor: "var(--border2)" }}>
          <h4 style={{ color: "var(--dim)" }}>Dependency: containerization</h4>
          <p style={{ fontSize: 12, color: "var(--dim)" }}>
            Code execution tools are blocked on the container runtime from the
            Infrastructure &rarr; Runtime roadmap. The skill registry and
            discovery layer can ship first &mdash; they only need metadata and
            built-in tools. Code-page execution unlocks when containers land.
            This is a feature gate, not a blocker for the registry itself.
          </p>
        </Card>
      </div>
    </div>
  );
}
