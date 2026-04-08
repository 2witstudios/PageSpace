import { useState, type CSSProperties } from "react";

/* ── Types ── */
type Status = "live" | "partial" | "planned";
type Persona = "user" | "team" | "admin" | "agent" | "developer" | "creator";

interface UserStory {
  as: Persona;
  want: string;
  so: string;
  status: Status;
  notes?: string;
}

interface Category {
  id: string;
  name: string;
  color: string;
  icon: string;
  description: string;
  stories: UserStory[];
}

/* ── Data ── */
const categories: Category[] = [
  {
    id: "content",
    name: "Content & Documents",
    color: "var(--green)",
    icon: "\u{1F4C4}",
    description: "Google Drive-like: create, edit, organize, and collaborate on content.",
    stories: [
      { as: "user", want: "create rich text documents with formatting, images, and embeds", so: "I can write and publish content in one place", status: "live" },
      { as: "user", want: "create and edit spreadsheets with formulas", so: "I can manage structured data", status: "live" },
      { as: "user", want: "draw on a freeform canvas with shapes and connectors", so: "I can diagram and brainstorm visually", status: "live" },
      { as: "user", want: "write and edit code with syntax highlighting", so: "I can store code alongside documentation", status: "live" },
      { as: "user", want: "upload files (images, PDFs, docs) and have them processed automatically", so: "I can access extracted text and optimized versions", status: "live" },
      { as: "user", want: "organize pages into folders with drag-and-drop reordering", so: "I can structure my workspace", status: "live" },
      { as: "user", want: "see version history for any page (30-day retention)", so: "I can restore previous versions or see what changed", status: "live" },
      { as: "user", want: "pin important page versions so they never expire", so: "I can preserve milestones", status: "live" },
      { as: "user", want: "search across all my pages by content or title", so: "I can find anything quickly", status: "live" },
      { as: "user", want: "favorite pages and drives for quick access", so: "I can navigate to frequently used content fast", status: "live" },
      { as: "user", want: "@mention other pages to create backlinks", so: "I can cross-reference related content", status: "live" },
      { as: "user", want: "trash and restore pages", so: "I can recover accidentally deleted work", status: "live" },
      { as: "creator", want: "publish pages as blog posts with a build pipeline", so: "my drive becomes a deployable website", status: "planned" },
      { as: "creator", want: "schedule content publication", so: "I can plan editorial calendars", status: "planned" },
      { as: "creator", want: "preview content before publishing", so: "I can review how it will look live", status: "planned" },
    ],
  },
  {
    id: "collaboration",
    name: "Collaboration & Sharing",
    color: "var(--cyan)",
    icon: "\u{1F91D}",
    description: "Real-time teamwork: sharing, permissions, presence, and communication.",
    stories: [
      { as: "user", want: "share pages with specific people (view/edit/share/delete permissions)", so: "I control who sees what", status: "live" },
      { as: "user", want: "see who else is viewing a page in real time", so: "I know when teammates are working on the same thing", status: "live" },
      { as: "user", want: "send direct messages to other users", so: "I can communicate without leaving PageSpace", status: "live" },
      { as: "user", want: "use channels for group conversations with reactions", so: "I can discuss topics with my team", status: "live" },
      { as: "user", want: "set expiring permissions on shared pages", so: "access automatically revokes after a deadline", status: "live" },
      { as: "team", want: "create drives as shared workspaces", so: "my team has a home for project content", status: "live" },
      { as: "team", want: "invite members with Owner/Admin/Member roles", so: "we have clear access control", status: "live" },
      { as: "team", want: "set a drive prompt (custom AI instructions)", so: "all agents in this workspace share the same context", status: "live" },
      { as: "team", want: "back up an entire drive (pages, permissions, files)", so: "I can restore the workspace if something goes wrong", status: "live" },
      { as: "admin", want: "manage custom roles with specific permission sets", so: "I can fine-tune access beyond Owner/Admin/Member", status: "live" },
      { as: "admin", want: "see an activity log of all changes in the drive", so: "I can audit who did what", status: "live" },
      { as: "admin", want: "manage my org's drives, billing, and API keys in one place", so: "governance is centralized", status: "planned" },
      { as: "user", want: "see a unified dashboard of activity across all my orgs", so: "I don't have to switch between workspaces", status: "planned" },
      { as: "admin", want: "team members to log in via our company's Okta/Azure AD (SAML/OIDC)", so: "we can enforce our enterprise security policies", status: "planned" },
      { as: "user", want: "log in with passkeys or magic links without ever setting a password", so: "authentication is simpler and more secure", status: "live" },
      { as: "user", want: "hide specific pages from AI agents", so: "private notes aren't included in agent context", status: "partial", notes: "visibleToGlobalAssistant exists in schema, UI not discoverable" },
      { as: "user", want: "push notifications on my phone when someone mentions me", so: "I stay informed without checking the app", status: "partial", notes: "iOS APNs works end-to-end; Android/Web stubbed" },
    ],
  },
  {
    id: "ai-chat",
    name: "AI Conversations",
    color: "var(--blue)",
    icon: "\u{1F4AC}",
    description: "ChatGPT-like: talk to AI with tools, context, and memory.",
    stories: [
      { as: "user", want: "chat with AI globally or scoped to a specific page/drive", so: "the AI has the right context for my question", status: "live" },
      { as: "user", want: "choose from 100+ models across 11 providers", so: "I can use the best model for each task", status: "live" },
      { as: "user", want: "AI that can create, edit, search, and organize my pages", so: "the AI is a real collaborator, not just a chatbot", status: "live" },
      { as: "user", want: "AI that can search the web for current information", so: "answers aren't limited to training data", status: "live", notes: "Brave web search with domain/recency filtering" },
      { as: "user", want: "AI that can manage my tasks (create, update, assign)", so: "I can delegate task management to the AI", status: "live" },
      { as: "user", want: "create custom AI agents with specialized system prompts", so: "I can build domain-specific assistants", status: "live" },
      { as: "user", want: "agents that see and can consult other agents in the workspace", so: "agents delegate to the right specialist", status: "live", notes: "ask_agent with MAX_DEPTH=2" },
      { as: "user", want: "stream AI responses in real time", so: "I see output as it's generated", status: "live" },
      { as: "user", want: "use my own API keys for AI providers", so: "I'm not locked into PageSpace's billing for models", status: "live" },
      { as: "user", want: "AI personalization (writing style, custom rules)", so: "the AI adapts to how I work", status: "live" },
      { as: "user", want: "AI that remembers across conversations (scoped memory)", so: "I don't repeat context every time", status: "planned" },
      { as: "user", want: "AI that can run code and interact with a shell", so: "it can actually build things, not just suggest", status: "planned" },
      { as: "user", want: "AI that schedules itself and runs autonomously", so: "agents work even when I'm not there", status: "planned" },
    ],
  },
  {
    id: "agents",
    name: "Agent System",
    color: "var(--violet)",
    icon: "\u{1F916}",
    description: "Autonomous agents: runtime, scheduling, workflows, and coordination.",
    stories: [
      { as: "agent", want: "execute in an autonomous loop (plan/execute/evaluate)", so: "I can handle complex multi-step tasks without human prompting", status: "planned" },
      { as: "agent", want: "run inside an isolated container with shell access", so: "I can write code, run tests, and use real dev tools", status: "planned" },
      { as: "agent", want: "schedule myself on a cron or react to events", so: "I can operate 24/7 without human triggers", status: "partial", notes: "Workflow cron exists but triggers tool-call agents, not CLI loops" },
      { as: "agent", want: "persist memory across conversations at multiple scopes", so: "I accumulate knowledge and don't repeat mistakes", status: "planned" },
      { as: "agent", want: "discover and load skills (pages with metadata)", so: "I can expand my capabilities dynamically", status: "planned" },
      { as: "agent", want: "have a budget limit (tokens/hour, cost ceiling)", so: "I can't run up unlimited costs", status: "planned" },
      { as: "agent", want: "orchestrate by writing to calendars, task lists, and asking other agents", so: "the workspace IS the orchestration layer \u2014 no separate DAG needed for adaptive work", status: "partial", notes: "Tools exist (calendar, tasks, ask_agent). Agent loop is the missing piece." },
      { as: "admin", want: "define repeatable DAG workflows that agents must follow (PR review, onboarding)", so: "human-enforced rules create guardrails agents can't skip", status: "planned" },
      { as: "agent", want: "be scored against a rubric after completing work", so: "quality is measured, not assumed", status: "planned" },
      { as: "agent", want: "create pages, documents, and apps from the same data", so: "I can build things that the team immediately uses", status: "partial", notes: "Can create/edit pages now, can't build deployable apps" },
      { as: "admin", want: "set capability gates per agent (which tools it can use)", so: "agents operate within defined boundaries", status: "planned" },
      { as: "admin", want: "see a full audit trail of every agent action", so: "I can review what agents did and why", status: "planned" },
      { as: "admin", want: "set per-agent and per-org AI spending budgets", so: "costs are controlled", status: "planned" },
    ],
  },
  {
    id: "ide",
    name: "IDE & Development",
    color: "var(--red)",
    icon: "\u{1F4BB}",
    description: "Code execution: terminals, git, containers, build pipelines.",
    stories: [
      { as: "developer", want: "open a terminal in the browser connected to a container", so: "I can run commands without leaving PageSpace", status: "planned" },
      { as: "developer", want: "clone a git repo into a PageSpace drive", so: "my codebase lives alongside my docs and agents", status: "planned" },
      { as: "developer", want: "branch, commit, and push from the PageSpace UI", so: "I can do git operations without a terminal", status: "planned" },
      { as: "developer", want: "browse repo files in a tree view mapped to the page tree", so: "code files and pages are one hierarchy", status: "planned" },
      { as: "developer", want: "edit code with Monaco editor (already exists for Code pages)", so: "I have a real code editing experience", status: "partial", notes: "Monaco exists for Code pages, needs full IDE integration" },
      { as: "developer", want: "create a BRANCH page that spins up an isolated container", so: "each branch has its own execution environment", status: "planned" },
      { as: "developer", want: "have agents run inside my branch container with shell access", so: "AI can write code, run tests, and fix bugs in a real environment", status: "planned" },
      { as: "developer", want: "trigger build/test/deploy pipelines from PageSpace", so: "I ship from where I build", status: "planned" },
      { as: "developer", want: "see agent coding activity streamed in real time", so: "I can watch and intervene if needed", status: "planned" },
    ],
  },
  {
    id: "search",
    name: "Search & Discovery",
    color: "var(--amber)",
    icon: "\u{1F50D}",
    description: "Finding information: page search, web search, semantic search.",
    stories: [
      { as: "user", want: "search pages by title and content with regex", so: "I can find exact matches across my workspace", status: "live" },
      { as: "user", want: "search across all my drives at once", so: "I find information regardless of which workspace it's in", status: "live" },
      { as: "user", want: "search the web for current information", so: "agents have access to up-to-date sources", status: "live", notes: "Brave web search with domain and recency filtering" },
      { as: "user", want: "search conversations and chat history", so: "I can find past agent reasoning and discussions", status: "live" },
      { as: "user", want: "use glob patterns to find pages by structure", so: "I can navigate large workspaces efficiently", status: "live" },
      { as: "user", want: "search by meaning, not just keywords (semantic search)", so: "I find relevant content even with different wording", status: "planned" },
      { as: "user", want: "search across agent memories and learnings", so: "knowledge accumulated by agents is discoverable", status: "planned" },
      { as: "user", want: "see a knowledge graph of how concepts connect", so: "I can explore relationships between ideas", status: "planned" },
      { as: "agent", want: "automatically get relevant context injected based on my task", so: "I don't have to manually search for what I need", status: "planned" },
    ],
  },
  {
    id: "integrations",
    name: "Integrations & Connectivity",
    color: "var(--cyan)",
    icon: "\u{1F517}",
    description: "External connections: GitHub, Calendar, OAuth, MCP, channels.",
    stories: [
      { as: "user", want: "connect my Google Calendar and see events in PageSpace", so: "my schedule is integrated with my workspace", status: "live" },
      { as: "user", want: "connect GitHub repos", so: "code and documentation live together", status: "live" },
      { as: "user", want: "use OAuth to connect external services", so: "integrations are secure and standard", status: "live" },
      { as: "user", want: "connect AI tools via MCP (Model Context Protocol)", so: "agents can use external capabilities", status: "live" },
      { as: "admin", want: "manage integration credentials securely (encrypted at rest)", so: "API keys and tokens are protected", status: "live" },
      { as: "admin", want: "control which integrations agents can access per drive", so: "I govern what external services agents use", status: "partial", notes: "Integration tool grants exist, per-org governance planned" },
      { as: "user", want: "receive notifications via Slack, Discord, or email", so: "I'm alerted when agents finish work or need attention", status: "planned" },
      { as: "user", want: "interact with PageSpace agents from Slack or Discord", so: "I don't have to open the web app for every interaction", status: "planned" },
      { as: "developer", want: "install CLIs and tools inside agent containers", so: "agents can use any external tool", status: "planned" },
    ],
  },
  {
    id: "platform",
    name: "Platform & Infrastructure",
    color: "var(--dim)",
    icon: "\u{2699}\u{FE0F}",
    description: "Multi-tenant, billing, deployment, desktop & mobile.",
    stories: [
      { as: "user", want: "use PageSpace on desktop (Mac, Windows, Linux)", so: "I have a native app experience", status: "live", notes: "Electron wrapper" },
      { as: "user", want: "use PageSpace on mobile (iOS, Android)", so: "I can access my workspace on the go", status: "live", notes: "Capacitor wrapper" },
      { as: "user", want: "sign up and manage my subscription with Stripe", so: "billing is self-service", status: "live" },
      { as: "user", want: "export all my data (GDPR compliance)", so: "I own my data and can leave anytime", status: "live" },
      { as: "admin", want: "provision isolated tenants for my organization", so: "our data is fully separated from other customers", status: "live", notes: "Control plane with Docker Compose provisioning" },
      { as: "admin", want: "suspend, resume, upgrade, and destroy tenant instances", so: "I manage our infrastructure lifecycle", status: "live" },
      { as: "user", want: "use a free tier on shared infrastructure", so: "I can try PageSpace without paying", status: "partial", notes: "Free tier exists, shared Postgres isolation planned" },
      { as: "admin", want: "have our org on dedicated infrastructure (own Postgres, Redis)", so: "we get full isolation and performance", status: "planned" },
      { as: "admin", want: "deploy on AWS with ECS + RDS", so: "we scale beyond a single VPS", status: "planned" },
      { as: "admin", want: "use Firecracker VMs for agent containers", so: "execution environments have hardware-level isolation", status: "planned" },
      { as: "admin", want: "manage org-level AI billing and API key governance", so: "costs and access are controlled centrally", status: "planned" },
    ],
  },
  {
    id: "creative",
    name: "Writing, Learning & Research",
    color: "var(--blue)",
    icon: "\u{1F4DA}",
    description: "Books, courses, research wikis, reading plans \u2014 long-form knowledge work with AI.",
    stories: [
      { as: "user", want: "write a book with AI assistance \u2014 outline, draft chapters, revise, all in one workspace", so: "the whole manuscript lives in a structured page tree with AI as a writing partner", status: "live", notes: "Drive = book, folders = parts, pages = chapters, AI_CHAT = writing agent" },
      { as: "user", want: "create an online course with lessons, modules, and exercises", so: "I can structure educational content and iterate with AI feedback", status: "live", notes: "Page tree = course structure, task lists = exercises/assignments" },
      { as: "user", want: "build interactive courses with task lists as learning checkpoints", so: "learners track their progress through the material", status: "live", notes: "TASK_LIST pages as learning paths with completion tracking" },
      { as: "user", want: "create a reading plan with a curated list of sources and progress tracking", so: "I can manage a reading program and take notes alongside the material", status: "live", notes: "Task list = reading queue, pages = notes per source" },
      { as: "user", want: "do deep research where AI ingests sources, summarizes them, and builds a wiki", so: "I get a structured knowledge base from raw inputs without organizing it myself", status: "live", notes: "Agents create/edit pages, file processor extracts text from PDFs, mentions for backlinks" },
      { as: "user", want: "have AI compile my notes and highlights into concept maps and summaries", so: "knowledge is synthesized, not just stored", status: "live", notes: "Agents can read all pages in scope and create summary documents" },
      { as: "developer", want: "use PageSpace as a memory bank for my coding agent (via MCP)", so: "my AI coding tools have persistent context about my projects, decisions, and patterns", status: "live", notes: "MCP tokens with drive scoping \u2014 coding agents read/write PageSpace pages as external memory" },
      { as: "user", want: "collaborate with a team on a research project where AI agents manage different domains", so: "each domain has a specialist agent and they cross-reference each other's work", status: "live", notes: "Multiple AI_CHAT agents in one drive with ask_agent delegation" },
      { as: "creator", want: "turn a course or book drive into a publishable website", so: "content goes from draft to live without leaving PageSpace", status: "planned" },
    ],
  },
  {
    id: "cms-crm",
    name: "CMS & CRM",
    color: "var(--green)",
    icon: "\u{1F680}",
    description: "Future: publishing, domains, contacts, pipelines, automation.",
    stories: [
      { as: "creator", want: "turn my drive into a deployable website", so: "pages become live content with a real URL", status: "planned" },
      { as: "creator", want: "map a custom domain to my drive", so: "my site has my branding", status: "planned" },
      { as: "creator", want: "use agents to generate and maintain content", so: "my site stays fresh without manual effort", status: "planned" },
      { as: "user", want: "manage contacts and leads as pages", so: "CRM data lives in the same workspace", status: "planned" },
      { as: "user", want: "build sales pipelines with stages", so: "I can track deals", status: "planned" },
      { as: "user", want: "automate outreach with agent-driven email sequences", so: "follow-ups happen automatically", status: "planned" },
      { as: "agent", want: "score leads based on engagement data", so: "the team focuses on the best opportunities", status: "planned" },
      { as: "user", want: "build custom internal tools on PageSpace data", so: "apps emerge from the same data I already use", status: "planned" },
    ],
  },
];

/* ── Styles ── */
const statusColors: Record<Status, { bg: string; color: string; border: string }> = {
  live: { bg: "rgba(61,214,140,0.1)", color: "var(--green)", border: "rgba(61,214,140,0.2)" },
  partial: { bg: "rgba(255,184,77,0.1)", color: "var(--amber)", border: "rgba(255,184,77,0.2)" },
  planned: { bg: "rgba(91,91,114,0.1)", color: "var(--dim)", border: "var(--border)" },
};

const personaColors: Record<Persona, string> = {
  user: "var(--blue)",
  team: "var(--cyan)",
  admin: "var(--red)",
  agent: "var(--violet)",
  developer: "var(--amber)",
  creator: "var(--green)",
};

function StatusPill({ status }: { status: Status }) {
  const s = statusColors[status];
  return (
    <span style={{
      fontSize: 9, fontWeight: 600, padding: "2px 8px", borderRadius: 20,
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      fontFamily: "var(--mono)", letterSpacing: 0.3,
    }}>
      {status}
    </span>
  );
}

function PersonaPill({ persona }: { persona: Persona }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 500, padding: "1px 6px", borderRadius: 10,
      color: personaColors[persona], fontFamily: "var(--mono)",
    }}>
      {persona}
    </span>
  );
}

function StoryCard({ story }: { story: UserStory }) {
  return (
    <div style={{
      background: "var(--s2)", border: "1px solid var(--border)",
      borderRadius: 10, padding: "12px 14px",
      borderLeft: `3px solid ${personaColors[story.as]}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
        <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.6 }}>
          <PersonaPill persona={story.as} />
          {" "}
          <span style={{ color: "var(--mid)" }}>I want to</span>{" "}
          <strong>{story.want}</strong>
          {" "}
          <span style={{ color: "var(--mid)" }}>so that</span>{" "}
          <span style={{ color: "var(--dim)" }}>{story.so}</span>
        </div>
        <StatusPill status={story.status} />
      </div>
      {story.notes && (
        <div style={{ fontSize: 10, color: "var(--dim)", fontFamily: "var(--mono)", marginTop: 4 }}>
          {story.notes}
        </div>
      )}
    </div>
  );
}

function CategorySection({ category, filter }: { category: Category; filter: Status | "all" }) {
  const [open, setOpen] = useState(true);
  const filtered = filter === "all" ? category.stories : category.stories.filter(s => s.status === filter);
  if (filtered.length === 0) return null;

  const counts = {
    live: category.stories.filter(s => s.status === "live").length,
    partial: category.stories.filter(s => s.status === "partial").length,
    planned: category.stories.filter(s => s.status === "planned").length,
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "none", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 10, width: "100%",
          padding: "8px 0", fontFamily: "var(--sans)",
        }}
      >
        <span style={{ fontSize: 20 }}>{category.icon}</span>
        <div style={{ flex: 1, textAlign: "left" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: category.color }}>
            {category.name}
            <span style={{ fontSize: 11, fontWeight: 400, color: "var(--dim)", marginLeft: 8 }}>
              {filtered.length} {filter === "all" ? "stories" : filter}
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--dim)" }}>{category.description}</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "var(--green)", fontFamily: "var(--mono)" }}>{counts.live} live</span>
          <span style={{ fontSize: 10, color: "var(--amber)", fontFamily: "var(--mono)" }}>{counts.partial} partial</span>
          <span style={{ fontSize: 10, color: "var(--dim)", fontFamily: "var(--mono)" }}>{counts.planned} planned</span>
        </div>
        <span style={{ fontSize: 12, color: "var(--dim)", transition: "transform 0.15s", transform: open ? "rotate(0)" : "rotate(-90deg)" }}>
          &#x25BC;
        </span>
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8, paddingLeft: 30 }}>
          {filtered.map((story, i) => (
            <StoryCard key={i} story={story} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Filters ── */
const filterBtn = (active: boolean, color: string): CSSProperties => ({
  fontSize: 11, fontWeight: 600, padding: "5px 14px", borderRadius: 20,
  border: active ? `1px solid ${color}` : "1px solid var(--border)",
  background: active ? `${color}15` : "transparent",
  color: active ? color : "var(--dim)",
  cursor: "pointer", fontFamily: "var(--sans)", transition: "all 0.15s",
});

export function UserStoriesPane() {
  const [filter, setFilter] = useState<Status | "all">("all");

  const totalStories = categories.reduce((sum, c) => sum + c.stories.length, 0);
  const liveCount = categories.reduce((sum, c) => sum + c.stories.filter(s => s.status === "live").length, 0);
  const partialCount = categories.reduce((sum, c) => sum + c.stories.filter(s => s.status === "partial").length, 0);
  const plannedCount = categories.reduce((sum, c) => sum + c.stories.filter(s => s.status === "planned").length, 0);

  return (
    <div className="pane">
      <div className="sl">User Stories</div>
      <h2>
        {totalStories} stories across {categories.length} categories.{" "}
        <span className="hl">{liveCount} live, {plannedCount} planned.</span>
      </h2>
      <p style={{ marginBottom: 28, maxWidth: 720 }}>
        PageSpace spans the use cases of ChatGPT (AI conversations, agent
        interactions) and Google Drive (file management, collaboration,
        content management) &mdash; both universal products. This is every
        user story, current and planned, organized by domain.
      </p>

      {/* ══════ E2E BUYING STORIES ══════ */}
      <div className="sl">Why people buy PageSpace</div>
      <h3 style={{ marginBottom: 16 }}>
        The end-to-end stories &mdash;{" "}
        <span style={{ color: "var(--blue)" }}>why someone picks PageSpace over the alternatives.</span>
      </h3>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 32 }}>
        {[
          {
            who: "Startup founder",
            color: "var(--blue)",
            story: "I need one place where my team writes docs, manages tasks, chats with AI, and collaborates in real time \u2014 without stitching together Notion + ChatGPT + Linear. AI that actually does work in my workspace, not just answers questions.",
            today: "Docs, tasks, AI with 33+ tools, real-time collaboration, 100+ models, team drives with RBAC. Works today.",
            status: "live" as Status,
          },
          {
            who: "Solo creator / knowledge worker",
            color: "var(--cyan)",
            story: "I want an AI workspace where I write, organize, and have agents help me research and draft \u2014 with web search, multiple AI models, and a page system that\u2019s actually good. Not just chat \u2014 AI that reads, writes, and organizes my content.",
            today: "Rich editor, 10 page types, AI with page CRUD + web search + agent delegation. Full workspace, not just a chatbot.",
            status: "live" as Status,
          },
          {
            who: "Agency / consultancy",
            color: "var(--green)",
            story: "I need isolated workspaces per client with strict access control. Each client gets their own AI agents, their own docs, their own data \u2014 and I manage it all. When a project ends, I hand off or archive the whole workspace.",
            today: "Multi-tenant drives with RBAC, per-page permissions, tenant provisioning via control plane. Works today.",
            status: "live" as Status,
          },
          {
            who: "Content team / marketing",
            color: "var(--amber)",
            story: "I want to write content in a beautiful editor, have AI help me draft and refine, and collaborate with my team in real time. All our content in one place with version history, not scattered across Google Docs and Notion.",
            today: "TipTap rich editor, AI drafting, real-time collab, version history, file uploads with OCR. Works today. Publishing pipeline is the next unlock.",
            status: "live" as Status,
          },
          {
            who: "Educator / researcher",
            color: "var(--green)",
            story: "I want a knowledge base where I dump papers and notes, and AI agents organize them \u2014 summaries, backlinks, concept organization. Like Obsidian meets ChatGPT, but the AI actually builds the wiki for me.",
            today: "Page tree, AI agents with create/edit/search tools, backlinks (mentions), file processing (OCR, text extraction). Agents can build knowledge bases today.",
            status: "live" as Status,
          },
          {
            who: "Enterprise / compliance-sensitive org",
            color: "var(--red)",
            story: "We need a workspace where every action is audited, data is encrypted at rest, we can export everything for compliance, and each team gets isolated infrastructure.",
            today: "Tamper-evident audit logs (hash chain), AES-256-GCM encryption, GDPR export, tenant isolation, per-event re-auth. Dedicated AWS infra is the next tier.",
            status: "live" as Status,
          },
          {
            who: "AI-first team (next wave)",
            color: "var(--violet)",
            story: "We want AI agents that work autonomously \u2014 researching, coding, reviewing, deploying \u2014 while we set the direction and review results. Agents that run 24/7, learn from past work, and operate within budgets we control.",
            today: "Agent conversations, multi-tool execution, and agent-to-agent delegation work today. Autonomous loops, containers, and budget controls are the next phase.",
            status: "partial" as Status,
          },
          {
            who: "Team replacing shared-brain AI tools",
            color: "var(--red)",
            story: "Our AI workspace exposed PII from private Slack DMs because the AI has access to everything. We need per-user isolation \u2014 shared skills but private data. Agents that run with MY permissions, not the team\u2019s.",
            today: "Per-user permission enforcement at the tool layer (not just UI). Private drives are unreachable by others. Shared drives = shared agents, but each invocation uses that user\u2019s access. Fail-closed.",
            status: "live" as Status,
          },
          {
            who: "Developer (next wave)",
            color: "var(--amber)",
            story: "I want an AI-powered workspace where I write specs, have agents build features in real containers, and deploy \u2014 all from one tool. Like if Cursor and Notion had a baby that could also host my site.",
            today: "Docs, code editing (Monaco), AI assistance all work. IDE with terminals, git integration, and containers is the next unlock.",
            status: "partial" as Status,
          },
        ].map((s, i) => (
          <div key={i} style={{
            background: "var(--s1)", border: "1px solid var(--border)",
            borderRadius: 12, padding: "16px 20px",
            borderLeft: `3px solid ${s.color}`,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: s.color }}>{s.who}</div>
              <StatusPill status={s.status} />
            </div>
            <p style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--text)", marginBottom: 8 }}>
              &ldquo;{s.story}&rdquo;
            </p>
            <div style={{ fontSize: 10, color: "var(--dim)", fontFamily: "var(--mono)" }}>
              {s.today}
            </div>
          </div>
        ))}
      </div>

      <hr />

      <div className="sl">Feature Stories</div>
      <h3 style={{ marginBottom: 16 }}>
        Every capability, broken down by domain.
      </h3>

      {/* Stats bar */}
      <div style={{
        display: "flex", gap: 12, marginBottom: 20, padding: "10px 16px",
        background: "var(--s1)", borderRadius: 10, border: "1px solid var(--border)",
        fontSize: 12, fontFamily: "var(--mono)",
      }}>
        <span style={{ color: "var(--text)", fontWeight: 600 }}>{totalStories} total</span>
        <span style={{ color: "var(--border)" }}>|</span>
        <span style={{ color: "var(--green)" }}>{liveCount} live</span>
        <span style={{ color: "var(--amber)" }}>{partialCount} partial</span>
        <span style={{ color: "var(--dim)" }}>{plannedCount} planned</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--mid)" }}>
          {Math.round((liveCount / totalStories) * 100)}% shipped
        </span>
      </div>

      {/* Filter buttons */}
      <div style={{ display: "flex", gap: 6, marginBottom: 24 }}>
        <button onClick={() => setFilter("all")} style={filterBtn(filter === "all", "var(--blue)")}>
          All
        </button>
        <button onClick={() => setFilter("live")} style={filterBtn(filter === "live", "var(--green)")}>
          Live
        </button>
        <button onClick={() => setFilter("partial")} style={filterBtn(filter === "partial", "var(--amber)")}>
          Partial
        </button>
        <button onClick={() => setFilter("planned")} style={filterBtn(filter === "planned", "var(--dim)")}>
          Planned
        </button>
      </div>

      {/* Categories */}
      {categories.map(cat => (
        <CategorySection key={cat.id} category={cat} filter={filter} />
      ))}
    </div>
  );
}
