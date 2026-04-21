import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI Chat",
  description: "How the AI Chat page type works in PageSpace — the conversation surface, the configuration panel (system prompt, tools, provider, model, read-only toggle), and sharing a chat with teammates.",
  path: "/docs/page-types/ai-chat",
  keywords: ["AI Chat", "agents", "system prompt", "read-only", "tools", "page type"],
});

const content = `
# AI Chat

An AI Chat is a dedicated conversation page with an AI agent. It sits in the page tree next to your documents and folders, has its own URL, its own permissions, and its own configuration — system prompt, enabled tools, provider, and model — all attached to that specific page.

## What you can do

- Create an AI Chat page anywhere in the tree from the **+** button in the sidebar or the slash menu inside another page.
- Chat directly on the page; replies and tool calls stream in as they arrive.
- Configure the agent from the page's settings panel: its **system prompt**, the **enabled tools** allow-list, the **provider** and **model**, a **read-only** toggle, and a **web search** toggle — all per page.
- Share an AI Chat page with teammates — everyone on the page sees the same live conversation and the same tool calls.
- Undo what the agent did on any turn — preview the edits that assistant message caused, then revert them as a group.
- @mention this AI Chat page from anywhere else in your workspace to pull it into that thread.

## How it works

An AI Chat page is just a page. It has a title, a parent, a URL, permissions, version history, a place in search. What's unique is the conversation inside: every user message, every agent reply, every tool call, and every tool result is persisted to the page so you can scroll back days later and see exactly what the agent did and why.

The configuration panel is where you shape the agent. The **system prompt** is a free-form text field that tells the agent what it is and how to behave. The **enabled tools** list is an explicit allow-list — any tool not in the list cannot be called from this page. The **provider** and **model** decide which backend runs the conversation. **Read-only mode** strips every write-capable tool on top of the allow-list, so the agent can still search and read but cannot create, edit, or delete. **Web search** is a single toggle that enables or disables one specific web-lookup tool.

Multi-user chat is built in: any teammate with access to the AI Chat page can post into the same conversation. User messages are attributed to their sender; the agent sees the whole thread and replies to everyone in real time.

## What it doesn't do

- **The agent doesn't act without a tool.** An empty tool allow-list means the page is chat-only — the agent cannot create, edit, delete, move, or send anything no matter what the prompt says. Empty is not a wildcard.
- **Read-only really is read-only.** A page with the toggle on cannot call a write tool even if the user asks for one. Write tools are removed from the menu before the model sees it — the prompt can't override it.
- **The system prompt lives on the page, not on you.** Sharing an AI Chat page with a teammate hands them the same prompt, tools, and provider selection; there's no per-user override.
- **Deleting the page deletes the conversation.** Trashing an AI Chat page moves its full history to trash along with the page; restoring the page restores the history. The underlying model provider is unaffected either way.
- **You can't branch a conversation.** Editing an earlier message doesn't fork the conversation into a new timeline — it edits in place and the subsequent turns stay where they are.

## Related

- [AI in your Workspace](/docs/features/ai) — how AI works across every page, @mentions, and agent-to-agent consultation.
- [Task Lists](/docs/page-types/task-list) — assigning an agent to a task so it picks up its own work.
- [Sharing & Permissions](/docs/features/sharing) — the rules an agent inherits when it acts on your behalf.
- [Pages](/docs/features/pages) — the universal page model an AI Chat page is built on.
`;

export default function PageTypeAIChatPage() {
  return <DocsMarkdown content={content} />;
}
