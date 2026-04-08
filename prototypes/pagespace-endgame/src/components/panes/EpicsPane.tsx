import { useState, type CSSProperties } from "react";
import { StatusBadge } from "../ui/StatusBadge";

/* ── Types ── */

type TaskStatus = "not-started" | "in-progress" | "done";

interface TaskDef {
  title: string;
  description: string;
  files?: string[];
  status: TaskStatus;
}

interface EpicDef {
  id: string;
  title: string;
  phase: number;
  status: "planned" | "in-progress" | "live";
  description: string;
  tasks: TaskDef[];
}

/* ── Styles ── */

const epicHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "14px 18px",
  background: "var(--s1)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  cursor: "pointer",
  marginBottom: 6,
  transition: "background 0.15s",
};

const epicBody: CSSProperties = {
  padding: "6px 18px 18px",
  marginBottom: 10,
  marginTop: -4,
  background: "var(--s1)",
  border: "1px solid var(--border)",
  borderTop: "none",
  borderRadius: "0 0 12px 12px",
};

const taskRow: CSSProperties = {
  display: "flex",
  gap: 10,
  padding: "10px 0",
  borderBottom: "1px solid rgba(42,42,61,0.4)",
  alignItems: "flex-start",
};

const phaseColors: Record<number, string> = {
  1: "var(--cyan)",
  2: "var(--blue)",
  3: "var(--green)",
  4: "var(--violet)",
  5: "var(--amber)",
  6: "var(--red)",
};

/* ── Sub-components ── */

function PhaseBadge({ phase }: { phase: number }) {
  const color = phaseColors[phase] ?? "var(--dim)";
  return (
    <span style={{
      fontSize: 9, fontWeight: 600, padding: "2px 8px",
      borderRadius: 20, fontFamily: "var(--mono)",
      background: `${color}15`, color, border: `1px solid ${color}30`,
      letterSpacing: 0.5, whiteSpace: "nowrap",
    }}>
      P{phase}
    </span>
  );
}

function TaskCheckIcon({ status }: { status: TaskStatus }) {
  const color =
    status === "done" ? "var(--green)" :
    status === "in-progress" ? "var(--blue)" :
    "var(--dim)";
  const fill = status === "done" ? color : "none";
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={{ flexShrink: 0, marginTop: 1 }}>
      <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.5" fill={fill} opacity={status === "not-started" ? 0.4 : 1} />
      {status === "done" && (
        <polyline points="5,8 7,10.5 11,5.5" fill="none" stroke="var(--s1)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {status === "in-progress" && (
        <circle cx="8" cy="8" r="3" fill={color} />
      )}
    </svg>
  );
}

function Task({ title, description, files, status }: TaskDef) {
  return (
    <div style={taskRow}>
      <TaskCheckIcon status={status} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: "var(--mid)", lineHeight: 1.6 }}>
          {description}
        </div>
        {files && files.length > 0 && (
          <div style={{ marginTop: 6, display: "flex", gap: 4, flexWrap: "wrap" }}>
            {files.map((f) => (
              <span key={f} style={{
                fontSize: 9, fontFamily: "var(--mono)", padding: "1px 7px",
                borderRadius: 4, background: "var(--s2)", border: "1px solid var(--border)",
                color: "var(--dim)",
              }}>{f}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 14 14"
      style={{
        flexShrink: 0,
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.15s",
        color: "var(--dim)",
      }}
    >
      <polyline points="5,3 9,7 5,11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Epic({ id, title, phase, status, description, tasks }: EpicDef) {
  const [open, setOpen] = useState(false);
  const badgeVariant = status === "live" ? "live" : status === "in-progress" ? "in-progress" : "planned";
  const done = tasks.filter((t) => t.status === "done").length;

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          ...epicHeader,
          ...(open ? { borderRadius: "12px 12px 0 0", marginBottom: 0 } : {}),
        }}
        onClick={() => setOpen(!open)}
      >
        <ChevronIcon open={open} />
        <PhaseBadge phase={phase} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", flex: 1 }}>
          <span style={{ color: "var(--dim)", fontFamily: "var(--mono)", fontSize: 10, marginRight: 8 }}>{id}</span>
          {title}
        </span>
        <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: "var(--dim)" }}>
          {done}/{tasks.length}
        </span>
        <StatusBadge variant={badgeVariant} />
      </div>
      {open && (
        <div style={epicBody}>
          <p style={{ fontSize: 12, color: "var(--mid)", lineHeight: 1.7, marginBottom: 14 }}>
            {description}
          </p>
          {tasks.map((t) => (
            <Task key={t.title} {...t} />
          ))}
        </div>
      )}
    </div>
  );
}

function PhaseHeader({ phase, title, weeks, color }: {
  phase: number; title: string; weeks: string; color: string;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "18px 0 10px", marginBottom: 4,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: 2,
        textTransform: "uppercase" as CSSProperties["textTransform"],
        color,
      }}>
        Phase {phase}: {title}
      </div>
      <span style={{
        fontSize: 9, fontFamily: "var(--mono)", padding: "2px 8px",
        borderRadius: 10, background: `${color}10`, color,
        border: `1px solid ${color}25`,
      }}>{weeks}</span>
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
    </div>
  );
}

/* ── Epic data ── */

const epics: EpicDef[] = [
  /* ── Phase 1: IDE / Coder Interface ── */
  {
    id: "E1.1", title: "BRANCH Page Type", phase: 1, status: "planned",
    description: "Introduce the BRANCH page type that represents a git branch backed by a container. This is the foundational page type that connects the page tree to execution infrastructure.",
    tasks: [
      { title: "Add BRANCH to pageType enum", description: "Extend the pageType enum in the core schema to include BRANCH as a valid page type.", files: ["packages/db/src/schema/core.ts"], status: "not-started" },
      { title: "Create BRANCH page creation UI component", description: "Build the UI for creating a new BRANCH page, including branch name input, repo selection, and environment configuration.", files: ["apps/web/src/app/(workspace)/branch/"], status: "not-started" },
      { title: "Wire BRANCH page to container provisioning API", description: "Connect the BRANCH page lifecycle to the control plane so creating/deleting a page provisions/destroys a container.", files: ["apps/web/src/app/api/"], status: "not-started" },
    ],
  },
  {
    id: "E1.2", title: "Container Provisioning", phase: 1, status: "planned",
    description: "Extend the control plane to provision per-branch Docker containers, with lifecycle management tied to page state.",
    tasks: [
      { title: "Extend control plane for per-branch Docker containers", description: "Add container provisioning logic that creates a Docker container when a BRANCH page is created, seeding it with the correct git repo and branch.", files: ["apps/control-plane/src/services/provisioning-engine.ts"], status: "not-started" },
      { title: "Container lifecycle management", description: "Implement create/pause/destroy operations tied to page lifecycle events. Pausing suspends the container; deleting destroys it.", status: "not-started" },
      { title: "Scoped auth tokens for container-to-API calls", description: "Generate scoped authentication tokens that containers use to call back to the PageSpace API with limited permissions.", files: ["packages/lib/src/auth/"], status: "not-started" },
    ],
  },
  {
    id: "E1.3", title: "Terminal Integration", phase: 1, status: "planned",
    description: "Add a terminal emulator to the PageSpace web UI so users and agents can interact with container shells directly from the browser.",
    tasks: [
      { title: "Add xterm.js + terminal component", description: "Integrate xterm.js as a terminal emulator component in the web app with theming that matches the PageSpace UI.", files: ["apps/web/src/components/"], status: "not-started" },
      { title: "WebSocket PTY bridge", description: "Create a WebSocket bridge from the browser terminal to the container's PTY, enabling real-time shell interaction.", files: ["apps/realtime/src/"], status: "not-started" },
      { title: "Terminal session management", description: "Support multiple terminal tabs, session reconnection on network interruption, and session history.", status: "not-started" },
    ],
  },
  {
    id: "E1.4", title: "Git Integration", phase: 1, status: "planned",
    description: "Provide git operations from within the PageSpace UI so users can clone, branch, commit, and push without leaving the workspace.",
    tasks: [
      { title: "Git clone/init on BRANCH page creation", description: "Automatically clone the target repository and check out the specified branch when a BRANCH page is created.", status: "not-started" },
      { title: "Branch/commit/push UI controls", description: "Build UI controls for common git operations: create branch, stage changes, write commit messages, push to remote.", files: ["apps/web/src/app/(workspace)/branch/"], status: "not-started" },
      { title: "Git status/diff display", description: "Show git status and file diffs inline in the PageSpace UI, highlighting changed files and allowing line-level review.", status: "not-started" },
    ],
  },
  {
    id: "E1.5", title: "File Browser", phase: 1, status: "planned",
    description: "A tree-view file browser that maps the repository filesystem to the page tree, enabling navigation and editing of repo files.",
    tasks: [
      { title: "Tree view component for repo filesystem", description: "Render the container's filesystem as an expandable tree view with icons, file types, and git status indicators.", files: ["apps/web/src/components/"], status: "not-started" },
      { title: "File open/edit routing to Monaco editor", description: "Opening a file from the tree view loads it in the Monaco code editor with appropriate language support.", status: "not-started" },
      { title: "Bidirectional page tree to file tree mapping", description: "Map PageSpace pages to filesystem paths and vice versa, so the page hierarchy reflects the repo structure.", status: "not-started" },
    ],
  },

  /* ── Phase 2: Agent Runtime ── */
  {
    id: "E2.1", title: "Runtime Service Scaffold", phase: 2, status: "planned",
    description: "Create the apps/runtime/ service that hosts agent execution, scheduling, and workflow orchestration as a dedicated Fastify server.",
    tasks: [
      { title: "Create apps/runtime/ with Fastify server", description: "Scaffold a new Fastify service in the monorepo with health checks, structured logging, and graceful shutdown.", files: ["apps/runtime/"], status: "not-started" },
      { title: "Shared Drizzle schema connection", description: "Connect the runtime service to the same PostgreSQL database using the shared Drizzle schema from packages/db.", files: ["packages/db/src/schema/"], status: "not-started" },
      { title: "Service-to-service auth with web app", description: "Implement mutual authentication between the runtime service and the web app using signed service tokens.", files: ["packages/lib/src/auth/"], status: "not-started" },
      { title: "Health check + Socket.IO integration", description: "Add health check endpoints and integrate with the realtime service via Socket.IO for streaming agent output to browsers.", files: ["apps/realtime/src/"], status: "not-started" },
    ],
  },
  {
    id: "E2.2", title: "Agent Loop", phase: 2, status: "planned",
    description: "The core agent execution cycle: receive a task, call an LLM, execute tools, evaluate results, and loop until the task is complete or limits are hit.",
    tasks: [
      { title: "Core execution cycle", description: "Implement the task-to-LLM-to-tools-to-evaluate loop with proper error handling, retries, and result aggregation.", files: ["apps/runtime/src/agent-loop.ts"], status: "not-started" },
      { title: "Loop guards (SHA256 cycle detection)", description: "Detect when an agent is stuck in a cycle by hashing recent action sequences and breaking out with escalation.", status: "not-started" },
      { title: "Context overflow recovery", description: "When context window fills, truncate tool results first, then older messages, preserving system prompt and recent context.", status: "not-started" },
      { title: "Max iteration limits with escalation", description: "Set configurable iteration limits per task. When hit, escalate to a human or parent agent rather than failing silently.", status: "not-started" },
    ],
  },
  {
    id: "E2.3", title: "Scheduling Engine", phase: 2, status: "planned",
    description: "Enable agents to run on schedules (cron), react to events (triggers), and operate in multiple modes from reactive to continuous.",
    tasks: [
      { title: "Cron expression parser + job persistence", description: "Parse cron expressions, persist scheduled jobs to the database, and execute them reliably with distributed locking.", files: ["apps/runtime/src/scheduler.ts"], status: "not-started" },
      { title: "Event trigger system", description: "Define triggers for lifecycle events (page created, file changed), content events (commit pushed), and custom webhooks.", status: "not-started" },
      { title: "Auto-disable after consecutive failures", description: "Automatically disable a schedule or trigger after N consecutive failures, with notification to the owner.", status: "not-started" },
      { title: "4 modes: reactive, periodic, proactive, continuous", description: "Support reactive (event-driven), periodic (cron), proactive (self-initiated within bounds), and continuous (long-running) agent modes.", status: "not-started" },
    ],
  },
  {
    id: "E2.4", title: "Budget & Metering", phase: 2, status: "planned",
    description: "Track and limit agent resource consumption with per-agent token/hour limits, per-model cost tracking, and org-level budget ceilings.",
    tasks: [
      { title: "Per-agent token/hour limits", description: "Configure maximum tokens per hour for each agent, with soft and hard limits that trigger warnings and shutdowns.", status: "not-started" },
      { title: "Per-model cost tracking", description: "Track costs per model used by each agent, accounting for input/output token pricing differences across providers.", status: "not-started" },
      { title: "Daily/monthly budget ceilings", description: "Set daily and monthly spending limits at the agent, drive, and org levels with rollover and alerting.", status: "not-started" },
      { title: "Usage reporting to billing service", description: "Report agent usage metrics to the billing service for inclusion in invoices and the usage dashboard.", files: ["packages/lib/src/services/"], status: "not-started" },
    ],
  },

  /* ── Phase 3: Memory + Entity State ── */
  {
    id: "E3.1", title: "Scoped Agent Memory", phase: 3, status: "planned",
    description: "Give agents persistent memory scoped to context, task, plan, or global levels, enabling learning and continuity across sessions.",
    tasks: [
      { title: "Memory table with scope enum", description: "Create a memory table with scope enum (context/task/plan/global) and key-value storage with metadata.", files: ["packages/db/src/schema/"], status: "not-started" },
      { title: "Read/write API for agents in runtime", description: "Expose memory read/write operations as tools available to agents during execution.", files: ["apps/runtime/src/"], status: "not-started" },
      { title: "Memory search (key-based + semantic)", description: "Support both exact key lookup and semantic similarity search over memory entries.", status: "not-started" },
      { title: "Scope inheritance", description: "Task-scoped memories are visible to the plan level. Plan-scoped memories are visible globally within the agent. Global memories persist across all tasks.", status: "not-started" },
    ],
  },
  {
    id: "E3.2", title: "Entity State Tables", phase: 3, status: "planned",
    description: "Structured tables for plans, tasks, mutations, ratings, and turn logs that provide full traceability from intent to code change.",
    tasks: [
      { title: "Drizzle schema: plans, tasks, mutations, ratings, turnLogs", description: "Define Drizzle ORM schema for all entity state tables with proper relations, indexes, and constraints.", files: ["packages/db/src/schema/entity-state.ts"], status: "not-started" },
      { title: "API routes for CRUD", description: "Create API routes for creating, reading, updating, and deleting entity state records with proper auth.", files: ["apps/web/src/app/api/"], status: "not-started" },
      { title: "Link entities: plan to tasks to mutations to commits", description: "Establish foreign key relationships so every code change traces back through mutation, task, plan to the original intent.", status: "not-started" },
      { title: "Traceability queries", description: "Build query helpers that answer: which plan caused this change? What tasks led to this commit? What was the agent's reasoning?", status: "not-started" },
    ],
  },
  {
    id: "E3.3", title: "Turso/SQLite Sync", phase: 3, status: "planned",
    description: "Embedded Turso/SQLite replicas inside containers for local-speed reads, with async write-back to the org's PostgreSQL.",
    tasks: [
      { title: "Turso embedded replica in containers", description: "Deploy Turso as an embedded SQLite replica inside each Firecracker VM, providing local-speed reads for agent operations.", status: "not-started" },
      { title: "Selective table sync from org Postgres", description: "Sync only the tables an agent needs (pages, memory, tasks) from the org database, not the full schema.", status: "not-started" },
      { title: "Async write-back with conflict resolution", description: "Buffer writes locally and sync back to Postgres asynchronously, handling conflicts with last-writer-wins or merge strategies.", status: "not-started" },
      { title: "Health monitoring for sync lag", description: "Monitor replication lag between Turso and Postgres, alerting when sync falls behind acceptable thresholds.", status: "not-started" },
    ],
  },
  {
    id: "E3.4", title: "Semantic Search", phase: 3, status: "planned",
    description: "Add vector-based semantic search alongside existing lexical search, enabling agents and users to find content by meaning.",
    tasks: [
      { title: "pgvector extension + embedding column on pages", description: "Enable the pgvector extension and add an embedding column to the pages table for storing vector representations.", files: ["packages/db/src/schema/core.ts"], status: "not-started" },
      { title: "Embedding generation pipeline", description: "Generate embeddings on page create/update using a configurable embedding model, with batch processing for existing content.", status: "not-started" },
      { title: "Hybrid search API (lexical + semantic ranking)", description: "Combine lexical (trigram/tsvector) and semantic (cosine similarity) search results with configurable ranking weights.", files: ["packages/lib/src/services/"], status: "not-started" },
      { title: "Integration with existing Brave web search", description: "Unify local semantic search with the existing Brave web search so agents get both internal and external results.", status: "not-started" },
    ],
  },

  /* ── Phase 4: Workflow Engine + Skills ── */
  {
    id: "E4.1", title: "Workflow Engine", phase: 4, status: "planned",
    description: "A general-purpose workflow engine that executes multi-step processes with branching, fan-out, error handling, and variable passing.",
    tasks: [
      { title: "Workflow definition schema", description: "Define a schema for workflows as DAGs: steps, edges, conditions, and variable bindings persisted in the database.", files: ["packages/db/src/schema/", "apps/runtime/src/workflow-engine.ts"], status: "not-started" },
      { title: "Step execution: sequential, fan-out, fan-in, conditional, loop", description: "Implement all step execution modes including parallel fan-out with configurable concurrency and join conditions.", status: "not-started" },
      { title: "Error modes: fail, skip, retry with backoff", description: "Per-step error handling configuration: fail the workflow, skip and continue, or retry with exponential backoff.", status: "not-started" },
      { title: "Variable passing between steps", description: "Pass outputs from one step as inputs to the next, with JSONPath-style selectors and type validation.", status: "not-started" },
    ],
  },
  {
    id: "E4.2", title: "Visual Workflow Builder", phase: 4, status: "planned",
    description: "A React Flow-based visual editor for building workflows by dragging skill nodes onto a canvas and connecting them.",
    tasks: [
      { title: "React Flow canvas for DAG editing", description: "Build a visual canvas using React Flow where users drag, drop, and connect workflow steps as nodes and edges.", files: ["apps/web/src/app/(workspace)/workflows/"], status: "not-started" },
      { title: "Drag skill nodes from catalog", description: "A skill catalog sidebar that lists available skills. Dragging a skill onto the canvas creates a configured workflow step.", status: "not-started" },
      { title: "Configure triggers, thresholds, routing", description: "UI panels for configuring when workflows run (triggers), their concurrency limits, and conditional routing between steps.", status: "not-started" },
      { title: "Serialize to workflow definitions", description: "Convert the visual canvas state to the workflow definition schema and back, enabling round-trip editing.", status: "not-started" },
    ],
  },
  {
    id: "E4.3", title: "Pages-as-Skills", phase: 4, status: "planned",
    description: "Turn Document and Code pages into reusable agent skills with system prompts, tool access, and context requirements.",
    tasks: [
      { title: "Skill metadata on Document/Code pages", description: "Add skill metadata fields to pages: system prompt, required tools, context requirements, input/output schema.", files: ["packages/db/src/schema/core.ts"], status: "not-started" },
      { title: "Skill catalog with search and discovery", description: "Build a catalog UI for browsing, searching, and previewing available skills across drives.", status: "not-started" },
      { title: "Skill composition", description: "Allow skills to reference other skills, enabling composite behaviors where one skill delegates sub-tasks to others.", status: "not-started" },
      { title: "Version tracking via page versions", description: "Leverage existing page versioning to track skill versions, enabling rollback and A/B testing of skill changes.", status: "not-started" },
    ],
  },
  {
    id: "E4.4", title: "Trigger Engine", phase: 4, status: "planned",
    description: "A flexible event system that connects code changes, agent lifecycle events, and system events to automated actions.",
    tasks: [
      { title: "Event sources: code, agent, system", description: "Define event sources: code (file changed, commit pushed), agent (spawned, finished, errored), system (cron, webhook, page lifecycle).", files: ["apps/runtime/src/"], status: "not-started" },
      { title: "Condition evaluation", description: "Evaluate conditions on events before firing triggers: file path patterns, branch names, agent states, custom predicates.", status: "not-started" },
      { title: "Action dispatch", description: "When a trigger fires, dispatch actions: run a skill, spawn an agent, write to memory, record a rating score.", status: "not-started" },
      { title: "Priority and debouncing", description: "Support trigger priority ordering and debouncing to prevent action storms from rapid-fire events.", status: "not-started" },
    ],
  },

  /* ── Phase 5: Database Split + AWS ── */
  {
    id: "E5.1", title: "Schema Split", phase: 5, status: "planned",
    description: "Separate the 89-table monolithic database into ~40 global tables and ~45 per-org tables, with a zero-downtime migration path.",
    tasks: [
      { title: "Identify and tag all 89 tables as global vs per-org", description: "Audit every table and classify it as global (auth, billing, monitoring) or per-org (content, conversations, tasks). Resolve dual-scoped edge cases.", files: ["packages/db/src/schema/"], status: "not-started" },
      { title: "Create migration scripts for table separation", description: "Build scripts that copy per-org tables from the monolithic database to dedicated org databases, preserving all relationships.", status: "not-started" },
      { title: "Dual-write period for zero-downtime migration", description: "During migration, write to both old and new databases simultaneously. Validate consistency before cutting over.", status: "not-started" },
      { title: "Resolve edge cases (dual-scoped tables)", description: "Handle tables like integrationProviders and googleCalendarConnections that span both global and org boundaries.", status: "not-started" },
    ],
  },
  {
    id: "E5.2", title: "Org/Team Layer", phase: 5, status: "planned",
    description: "Add an organizations layer above drives for team governance, AI billing, and user aggregation across multiple orgs.",
    tasks: [
      { title: "Organizations table + org membership", description: "Create organizations and orgMembers tables with roles (owner, admin, member) and invitation flow.", files: ["packages/db/src/schema/"], status: "not-started" },
      { title: "Org-level settings (AI billing, API keys, integrations)", description: "Move AI provider API keys, billing settings, and integration credentials to the org level.", status: "not-started" },
      { title: "User dashboard aggregation across orgs", description: "Build a user dashboard that aggregates activity, notifications, and recent items across all orgs the user belongs to.", files: ["apps/web/src/app/(workspace)/dashboard/"], status: "not-started" },
      { title: "Drive assignment to orgs", description: "Migrate existing drives to belong to organizations, with a default personal org for individual users.", status: "not-started" },
    ],
  },
  {
    id: "E5.3", title: "AWS Provisioner", phase: 5, status: "planned",
    description: "Implement the AwsProvisioner that swaps Docker Compose for ECS Fargate, RDS, ElastiCache, and S3.",
    tasks: [
      { title: "AwsProvisioner implementing Provisioner interface", description: "Create AwsProvisioner class implementing the existing Provisioner interface (provision, suspend, resume, destroy, upgrade, healthCheck).", files: ["apps/control-plane/src/services/"], status: "not-started" },
      { title: "ECS Fargate task definitions per service", description: "Define ECS Fargate task definitions for web, realtime, processor, and runtime services using the same Docker images.", status: "not-started" },
      { title: "RDS instance provisioning (shared vs dedicated)", description: "Provision shared RDS for free orgs and dedicated RDS instances for paid teams, with automated backup configuration.", status: "not-started" },
      { title: "ElastiCache + S3 setup", description: "Provision ElastiCache Redis clusters and S3 buckets per org, with ALB routing using wildcard certificates.", status: "not-started" },
    ],
  },
  {
    id: "E5.4", title: "Firecracker Migration", phase: 5, status: "planned",
    description: "Replace Docker containers for branch execution with Firecracker micro-VMs for hardware-level isolation and sub-125ms boot times.",
    tasks: [
      { title: "Firecracker VM provisioner", description: "Build a Firecracker provisioner that replaces Docker for branch containers, providing hardware-level isolation.", status: "not-started" },
      { title: "Boot time optimization (<125ms target)", description: "Optimize VM images and boot sequences to achieve sub-125ms cold start times for branch containers.", status: "not-started" },
      { title: "Resource limits and isolation verification", description: "Configure CPU, memory, and network limits per VM. Verify isolation with security testing.", status: "not-started" },
      { title: "Turso sync verification in Firecracker context", description: "Verify Turso/SQLite sync works correctly inside Firecracker VMs, handling the different networking model.", status: "not-started" },
    ],
  },

  /* ── Phase 6: CMS + Generated Interfaces ── */
  {
    id: "E6.1", title: "Publishing Pipeline", phase: 6, status: "planned",
    description: "Turn drives into deployable websites with build pipelines, static content compilation, and preview environments.",
    tasks: [
      { title: "Build pipeline config on drives", description: "Add build configuration to drives: build command, output directory, environment variables, and deployment triggers.", files: ["packages/db/src/schema/core.ts"], status: "not-started" },
      { title: "Page to static content compilation", description: "Compile PageSpace pages (Document, Code, Sheet) into static HTML/CSS/JS output suitable for web deployment.", status: "not-started" },
      { title: "Deployment triggers (on commit, on schedule)", description: "Configure automatic deployments triggered by git commits, cron schedules, or manual publish actions.", status: "not-started" },
      { title: "Preview environments per branch", description: "Deploy preview environments for each branch with unique URLs, enabling review before merging to production.", status: "not-started" },
    ],
  },
  {
    id: "E6.2", title: "Domain Routing", phase: 6, status: "planned",
    description: "Map custom domains to drives so every PageSpace workspace can serve as a published website.",
    tasks: [
      { title: "Custom domain mapping to drives", description: "Allow users to map custom domains to their drives, serving the drive's published content at that domain.", status: "not-started" },
      { title: "SSL cert provisioning (Let's Encrypt)", description: "Automatically provision and renew SSL certificates via Let's Encrypt for custom domains.", status: "not-started" },
      { title: "DNS verification flow", description: "Guide users through DNS configuration with verification checks and clear error messages for misconfiguration.", status: "not-started" },
      { title: "CDN integration", description: "Serve published content through a CDN for global performance, with cache invalidation on new deployments.", status: "not-started" },
    ],
  },
  {
    id: "E6.3", title: "CRM Features", phase: 6, status: "planned",
    description: "Layer CRM capabilities on top of the CMS: contacts, pipelines, email sequences, and agent-driven lead scoring.",
    tasks: [
      { title: "Contact/lead page type or schema", description: "Define a contact/lead data model either as a new page type or as structured schema tables with custom fields.", status: "not-started" },
      { title: "Pipeline/stage management", description: "Build visual pipeline management with customizable stages, drag-and-drop deal movement, and stage-based automations.", status: "not-started" },
      { title: "Email sequence automation via workflows", description: "Use the workflow engine to define and execute email sequences triggered by lead actions or pipeline stage changes.", status: "not-started" },
      { title: "Agent-driven lead scoring", description: "Deploy agents that analyze lead behavior, content engagement, and interaction history to assign and update lead scores.", status: "not-started" },
    ],
  },
  {
    id: "E6.4", title: "Agent Dashboard", phase: 6, status: "planned",
    description: "A real-time monitoring dashboard for all agents across the org, showing status, costs, health, and conversation history.",
    tasks: [
      { title: "Real-time agent status monitoring", description: "Display live status of all running agents: current task, iteration count, time elapsed, and resource consumption.", files: ["apps/web/src/app/(workspace)/dashboard/"], status: "not-started" },
      { title: "Cost tracking per agent/org", description: "Show accumulated costs per agent and per org with breakdowns by model, time period, and task.", status: "not-started" },
      { title: "Health/uptime metrics", description: "Track agent success rates, error frequencies, average task completion times, and uptime percentages.", status: "not-started" },
      { title: "Conversation and memory browser", description: "Browse agent conversation histories and memory entries with search, filtering, and export capabilities.", status: "not-started" },
    ],
  },
];

/* ── Summary stats ── */

function PhaseSummary() {
  const phases = [
    { phase: 1, title: "IDE / Coder Interface", subtitle: "THE UNLOCK" },
    { phase: 2, title: "Agent Runtime", subtitle: "autonomous agents" },
    { phase: 3, title: "Memory + Entity State", subtitle: "learning + traceability" },
    { phase: 4, title: "Workflow Engine + Skills", subtitle: "orchestration" },
    { phase: 5, title: "Database Split + AWS", subtitle: "scale + isolation" },
    { phase: 6, title: "CMS + Generated Interfaces", subtitle: "deployable products" },
  ];

  return (
    <div className="g3" style={{ marginBottom: 28 }}>
      {phases.map((p) => {
        const phaseEpics = epics.filter((e) => e.phase === p.phase);
        const totalTasks = phaseEpics.reduce((sum, e) => sum + e.tasks.length, 0);
        const doneTasks = phaseEpics.reduce((sum, e) => sum + e.tasks.filter((t) => t.status === "done").length, 0);
        const color = phaseColors[p.phase] ?? "var(--dim)";
        return (
          <div key={p.phase} style={{
            background: "var(--s1)", border: `1px solid ${color}25`,
            borderRadius: 10, padding: "14px 16px",
            borderLeft: `3px solid ${color}`,
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: 1, marginBottom: 4 }}>
              PHASE {p.phase}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>
              {p.title}
            </div>
            <div style={{ fontSize: 10, color: "var(--dim)", marginBottom: 8 }}>{p.subtitle}</div>
            <div style={{ fontSize: 9, fontFamily: "var(--mono)", color: "var(--mid)" }}>
              {phaseEpics.length} epics / {doneTasks}/{totalTasks} tasks
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Main pane ── */

export function EpicsPane() {
  return (
    <div className="pane">
      <div className="sl">Work Breakdown</div>
      <h2>
        24 epics. 88 tasks.{" "}
        <span className="hl">Six phases to the end game.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        Every epic breaks down into concrete tasks with file paths and status tracking.
        Click an epic to expand its task list. Phase 1 is the unlock &mdash;
        IDE enables CMS enables CRM. Everything else builds on it.
      </p>

      <PhaseSummary />

      {/* Phase 1 */}
      <PhaseHeader phase={1} title="IDE / Coder Interface" weeks="6-8 weeks" color="var(--cyan)" />
      {epics.filter((e) => e.phase === 1).map((e) => <Epic key={e.id} {...e} />)}

      {/* Phase 2 */}
      <PhaseHeader phase={2} title="Agent Runtime" weeks="6-8 weeks" color="var(--blue)" />
      {epics.filter((e) => e.phase === 2).map((e) => <Epic key={e.id} {...e} />)}

      {/* Phase 3 */}
      <PhaseHeader phase={3} title="Memory + Entity State" weeks="4-6 weeks" color="var(--green)" />
      {epics.filter((e) => e.phase === 3).map((e) => <Epic key={e.id} {...e} />)}

      {/* Phase 4 */}
      <PhaseHeader phase={4} title="Workflow Engine + Skills" weeks="4-6 weeks" color="var(--violet)" />
      {epics.filter((e) => e.phase === 4).map((e) => <Epic key={e.id} {...e} />)}

      {/* Phase 5 */}
      <PhaseHeader phase={5} title="Database Split + AWS" weeks="4-6 weeks" color="var(--amber)" />
      {epics.filter((e) => e.phase === 5).map((e) => <Epic key={e.id} {...e} />)}

      {/* Phase 6 */}
      <PhaseHeader phase={6} title="CMS + Generated Interfaces" weeks="4-6 weeks" color="var(--red)" />
      {epics.filter((e) => e.phase === 6).map((e) => <Epic key={e.id} {...e} />)}
    </div>
  );
}
