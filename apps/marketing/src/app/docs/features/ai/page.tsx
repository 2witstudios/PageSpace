import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI in your Workspace",
  description: "How AI works across PageSpace — @mentioning agents from any page, agent-to-agent consultation, the permissions model, supported providers, and what agents can and can't touch.",
  path: "/docs/features/ai",
  keywords: ["AI", "agents", "mentions", "providers", "permissions", "tool calling"],
});

const content = `
# AI in your Workspace

AI in PageSpace isn't bolted on — it's a behaviour the whole product shares. Any **AI Chat page** can be @mentioned from any document, channel, sheet cell, or other chat; agents can consult other agents; and when an agent acts, it acts under your permissions, using real workspace tools.

## What you can do

- @mention an AI Chat page from a document, channel, sheet cell, or another AI Chat to pull that agent into the thread.
- Use the **global assistant** in the right-hand sidebar to work across every drive you can see.
- Ask one agent to consult another by name — the called agent runs under its own prompt and tools, then returns a single response.
- Pick your provider and model in **Settings > AI**. Bring your own key for any supported provider, or use the built-in PageSpace provider with no key at all.
- Restrict any agent to a specific toolset by editing its AI Chat page's allow-list.
- Toggle **Read-only mode** on any AI Chat page to guarantee it cannot create, edit, or delete anything.
- Toggle **Web search** on any AI Chat page to let that agent look things up outside your workspace.
- Undo what an agent did on any turn — preview the edits that assistant message caused, then revert them as a group.

## How it works

**Providers.** PageSpace routes your conversation to one of 12 providers through a single underlying pipe. You pick the provider in settings; models show up once the provider is configured. Keys are encrypted at rest and scoped to your account — they are never shared with teammates, so each user configures their own.

**Permissions.** When an agent acts, it acts as **you**. It can only see pages you can see and only change pages you can change. Share a page with a teammate and *their* agents can now see it too, under their account. Revoke access and the agents lose access immediately — there is no AI back-door.

**Tools.** Every AI Chat page carries an allow-list of tools it may use. If the list is empty, the agent can chat but cannot act. The read-only toggle strips every write tool (create, edit, delete, send) on top of that list; the web-search toggle adds or removes the one web-lookup tool.

**@mentions.** Any AI Chat page can be @mentioned from a document, channel, sheet cell, or another chat. Mentioning an agent inside a channel pulls it into that thread as a participant — it reads the context around the mention and replies there.

**Agent-to-agent.** One agent can consult another by name. The called agent runs under its own system prompt and tools, but still with the *calling user's* permissions, and returns a single response. Chains are depth-capped so agents can't spiral into each other forever.

## What it doesn't do

- **It doesn't see what you can't see.** Sharing goes through the normal permissions system; an agent you own cannot read pages you don't have access to, even if a teammate asks it to.
- **It doesn't act without a tool.** An agent with an empty tool list can chat but will not create, edit, delete, move, or send anything. Empty is not a wildcard — nothing means nothing.
- **It doesn't run on its own schedule.** An agent responds when you message it, @mention it, or another agent consults it. It does not poll your workspace in the background or act while no one is watching.
- **Web search is off by default.** Agents stay inside your workspace unless you turn web search on for that specific AI Chat page.
- **Your API keys are yours alone.** Keys live on your user, encrypted, and are not shared with teammates on the same drive.
- **Agents can't call each other forever.** Agent-to-agent chains have a bounded depth cap; a loop of agents asking agents will stop instead of running up your bill.
- **It doesn't bypass billing or plan limits.** The built-in PageSpace provider has a per-day call budget by plan, and bring-your-own-key providers run against your own account with the provider.

## Related

- [AI Chat](/docs/page-types/ai-chat) — the page type the agent lives in, and its per-page configuration.
- [Channels](/docs/page-types/channel) — where @-mentioning an agent pulls it into a live thread.
- [Task Lists](/docs/page-types/task-list) — assigning work to an agent so it picks it up.
- [Sharing & Permissions](/docs/features/sharing) — the rules an agent inherits when it acts.
- [Search](/docs/features/search) — what the agent's search tools can reach.
- [MCP Integration](/docs/integrations/mcp) — connecting external AI clients like Claude Desktop and Cursor.
`;

export default function FeaturesAIPage() {
  return <DocsMarkdown content={content} />;
}
