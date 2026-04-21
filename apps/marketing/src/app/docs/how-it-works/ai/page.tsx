import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI in your Workspace",
  description: "Where AI lives in PageSpace, what it can touch, and how to keep it read-only when you want.",
  path: "/docs/how-it-works/ai",
  keywords: ["AI", "agents", "AI chat", "mentions", "read-only", "providers"],
});

const content = `
# AI in your Workspace

AI in PageSpace is a page, not a chatbot bolted on the side. You create an **AI Chat page** wherever you want an assistant to live, and that page can read, write, search, and organise content right next to the pages and people around it.

## What you can do

- Create an AI Chat page anywhere in your tree — in a project folder, at the top of a drive, or inside a channel thread.
- @mention any AI Chat page from a document, channel, sheet cell, or another AI Chat to pull that agent into the thread.
- Pick the provider and model per page, per drive, or as your personal default — in **Settings > AI**.
- Bring your own key for any supported provider, or use the built-in PageSpace provider with no key at all.
- Write a system prompt that tells the agent what it is, what tone to use, and what it should and shouldn't do.
- Choose exactly which tools the agent is allowed to call — e.g. "read and search only", or "read, edit, and update tasks".
- Turn on **Read-only mode** on any AI Chat page to guarantee the agent cannot create, edit, or delete anything.
- Turn on **Web search** on any AI Chat page to let that agent look things up outside your workspace.
- Share an AI Chat page with teammates — everyone on the page sees the same live conversation and the same tool calls.
- Ask one agent to consult another (e.g. your project agent pings your finance agent) without leaving the thread.
- Undo what an agent did on any turn — preview the edits that assistant message caused, then revert them as a group.
- Use the global assistant in the right-hand sidebar to work across every drive you can see.

## How it works

An AI Chat page behaves like every other page. It has a title, a parent, permissions, a URL, and a place in search. You share it, move it, and @mention it the same way you'd treat a document.

What's special is **what it does when you send a message**. The agent doesn't answer from inside its own head — it decides which workspace tools to call, then calls them. Creating a page is a tool call. Editing a line in a document is a tool call. Searching a drive, posting to a channel, updating a task, reading a sheet cell, checking your calendar — each one is a real action on your actual workspace, running under your account and your permissions.

A few moving parts you'll notice:

- **Provider and model.** PageSpace routes your conversation to one of 12 providers through a single underlying pipe. You pick the provider in settings; models show up once the provider is configured. Keys are encrypted at rest and scoped to your account — they are never shared with teammates.
- **Tools.** Every AI Chat page carries an allow-list of tools it may use. If the list is empty, the agent can chat but cannot act. The built-in read-only toggle strips every write tool (create, edit, delete, send) on top of that list; the web-search toggle adds or removes the one web-lookup tool.
- **Permissions.** When an agent acts, it acts as **you**. It can only see pages you can see and only change pages you can change. Share a page with a teammate and *their* agents can now see it too, under their account. Revoke access and the agents lose access immediately.
- **@mentions.** Any AI Chat page can be @mentioned from a document, channel, sheet cell, or another chat. Mentioning an agent inside a channel pulls it into that thread as a participant — it reads the context around the mention and replies there.
- **Agent-to-agent.** One agent can consult another by name. The called agent runs under its own system prompt and tools, but still with the *calling user's* permissions, and returns a single response. Chains are depth-capped so agents can't spiral into each other forever.
- **Multi-user chat.** Several teammates can share one AI Chat page. Every user message is attributed to its sender; the assistant sees the whole thread and replies to everyone in real time.
- **Memory.** Every turn — user text, agent text, each tool call, each tool result — is persisted to the page. You can scroll back days later and see exactly what the agent did and why.

## What it doesn't do

- **It doesn't see what you can't see.** An agent you own cannot read pages you don't have access to, even if a teammate asks it to. Sharing goes through the normal permissions system; there is no AI back-door.
- **It doesn't act without a tool.** An agent with an empty tool list can chat but will not create, edit, delete, move, or send anything. An empty allow-list is not a wildcard — nothing means nothing.
- **Read-only really is read-only.** A page with read-only mode on cannot call a write tool, no matter what the prompt says or what the user asks. The write tools are physically removed from the menu before the model sees it.
- **Web search is off by default.** Agents stay inside your workspace unless you turn web search on for that specific AI Chat page. No agent silently browses the internet.
- **It doesn't run on its own schedule.** An agent responds when you message it, @mention it, or another agent consults it. It does not poll your workspace in the background or act while no one is watching.
- **Your API keys are yours alone.** Keys live on your user, encrypted, and are not shared with teammates on the same drive — each user configures their own providers.
- **Agents can't call each other forever.** Agent-to-agent chains have a bounded depth cap; a loop of agents asking agents will stop instead of running up your bill.
- **Deleting the page doesn't delete the model.** Trashing an AI Chat page moves the conversation to trash like any other page; restoring the page restores the full history, including tool calls. The underlying model provider is unaffected either way.
- **It doesn't bypass billing or plan limits.** The built-in PageSpace provider has a per-day call budget by plan, and bring-your-own-key providers run against your own account with the provider — PageSpace doesn't absorb those costs.

## Related

- [Pages](/docs/how-it-works/pages) — the universal page model an AI Chat page is built on.
- [Channels](/docs/how-it-works/channels) — how @mentioning an agent pulls it into a thread.
- [Task Lists](/docs/how-it-works/task-lists) — assigning work to an agent.
- [Sharing & Permissions](/docs/how-it-works/sharing) — the rules an agent inherits when it acts on your behalf.
- [Search](/docs/how-it-works/search) — what the agent's search tools can actually reach.
`;

export default function HowItWorksAIPage() {
  return <DocsMarkdown content={content} />;
}
