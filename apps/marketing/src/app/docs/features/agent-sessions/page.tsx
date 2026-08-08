import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Agent Sessions & Sandbox",
  description: "Agent sessions give an agent a real cloud machine — a terminal, a filesystem, real code execution. How sessions and panes work, what's free vs. Pro, and how Workflows can run code too.",
  path: "/docs/features/agent-workspaces",
  keywords: ["agent sessions", "sandbox", "terminal", "code execution", "panes", "workflows", "cloud"],
});

const content = `
# Agent Sessions & Sandbox

An **agent session** is a real cloud machine behind an agent conversation — its own filesystem, its own shell, its own life for as long as the session runs. Sessions, chat, and the **panes** that lay them out are free for every account. The machine itself — the sandbox where an agent actually runs code — is a **Pro plan and above** feature.

## What you can do

- Start a session from the **Agents** screen — a drive-scoped session for one of that drive's agents, or a driveless session with the Global Assistant.
- Split the Agents screen into **panes**: side-by-side columns, and rows stacked inside each one. A pane can hold an agent conversation, a terminal, or any other page (a document, a task list, a sheet).
- Open a **terminal** pane on a session to work in the same machine your agent is using — the same filesystem, live.
- On Pro and above, let an agent actually run code: read and write real files, run a build, call \`git\`, all inside its own sandboxed machine.
- Run more than one agent in the same session's panes at once — an agent next to the terminal it's driving, or next to the document or task list it's working on.
- Turn on **code execution** for any of your own agents from that agent's settings — off by default, so an agent only gets sandbox tools when you deliberately grant them.
- Trigger **Workflows** (scheduled, webhook, task, or calendar-triggered automations) that write and run code themselves, the same way an interactive session does.

## How it works

**Sessions vs. the sandbox.** Starting a session — opening the panes UI, chatting, splitting panes, working with any page — costs nothing and works on every plan. The sandbox is a separate, deliberate step: a session only provisions a real cloud machine when you (or your agent) actually need one, such as opening a terminal.

**Who can use the sandbox.** Sandbox access follows the session's **payer** — the drive's owner, or the session's own owner for a driveless Global Assistant session — not necessarily whoever is using it in the moment. If a drive is owned by a Pro-plan account, every member of that drive with edit access can use the sandbox in a session scoped to it, even if their own personal account is on Free. When the resolved payer is on Free — your own drives, or your own Global Assistant sessions, while your account is on Free — you still get the full session/chat/panes interface; only the terminal and code-execution affordances are disabled, with a prompt to upgrade.

**Cost.** Sandbox time draws from the same credit balance as everything else you do in PageSpace on Pro and above — there's no separate charge or add-on.

**Panes.** A pane grid is two levels: columns side by side, and rows stacked inside each column. Each pane independently holds a chat, a terminal, or a page. Panes are saved per session, so reopening one restores exactly what you had open.

**Per-agent code execution.** Every AI Chat agent has its own sandbox toggle, off by default. An agent with it off never sees bash, file, or git tools — no allow-list can re-grant them. Turning it on is what lets that agent actually run code the next time it's in a session with a sandbox.

**Workflows.** A scheduled or triggered Workflow honors the exact same rules as an interactive session: the agent it runs needs code execution turned on, and the drive it runs in needs a Pro-and-above payer. When both are true, a workflow can write and run real code unattended — pull data, run a script, commit a result — not just read and summarize.

**Bring your own tools.** The sandbox is a genuine machine, not a single-purpose box. If you already work with a particular coding-agent CLI, it runs in the terminal the same way any other command does.

## Related

- [AI in your Workspace](/docs/features/ai) — the agent model sessions build on: permissions, tools, and models.
- [AI Chat](/docs/page-types/ai-chat) — where an agent's code-execution toggle and other settings live.
- [Task Lists](/docs/page-types/task-list) — a common pane pairing with an agent driving the work.
- [PageSpace CLI](/docs/features/cli) — the terminal-driven way to work with PageSpace outside the browser.
`;

export default function FeaturesAgentSessionsPage() {
  return <DocsMarkdown content={content} />;
}
