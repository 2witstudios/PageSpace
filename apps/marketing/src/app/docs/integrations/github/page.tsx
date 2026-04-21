import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "GitHub — Integration",
  description: "How GitHub works as a PageSpace integration: OAuth once, drive-scoped visibility, and 24 agent tools for reading repos and acting on issues and pull requests.",
  path: "/docs/integrations/github",
  keywords: ["GitHub", "integration", "pull requests", "issues", "code search", "AI tools"],
});

const content = `
# GitHub

Give your agents a GitHub identity. Once connected, they can read repositories, search code, browse branches and commits, and — with write tools enabled — open issues, leave PR reviews, and comment on behalf of you. Every action on GitHub happens under your account.

## What you can do

- Connect GitHub from **Settings → Integrations**. One OAuth click and you're in.
- Choose who in your workspace can use the connection — keep it **private**, expose it to **drives you own**, or share with **every drive you're in**.
- Put the GitHub tools on an [AI Chat](/docs/page-types/ai-chat) page's allow-list to let that agent use them.
- Ask an agent to find a function across a repo, summarize recent commits, or pull the diff of a PR.
- Have an agent file a bug, close a stale issue, or post a structured review on a pull request with inline comments.
- Leave GitHub off a chat entirely — an AI Chat with no GitHub tools allow-listed cannot touch your repos.

## How it works

**One OAuth flow, scopes you can read.** Connecting asks for \`repo\` and \`read:user\`. That's broad — it covers private repos and write access to code, issues, and PRs on any repo your GitHub account can reach. There is no narrower OAuth variant; if you want to cap what an agent can actually *do*, cap it at the tool allow-list on each [AI Chat](/docs/page-types/ai-chat).

**The token is yours. Visibility is the lever.** You control which agents can discover the connection by setting visibility to *private*, *owned drives*, or *all drives* when you connect. But tools always execute with your GitHub token and your GitHub permissions — if a teammate's agent uses your connection, it's still your account on the other end.

**Agents get 24 tools**, split into read and write. Read covers repositories, file trees and contents, branches, commits, code search, issues (get, list, comments), and pull requests (get, list, diffs, reviews, inline review comments). Write covers creating and updating issues, posting comments, creating a PR review, and leaving inline PR review comments. The write set is rate-limited tighter than read — **30 requests per minute** globally, dropping to **10 per minute** for any call that writes.

**Nothing renders inside PageSpace.** GitHub is agent-only — there's no inline PR or issue view on a page, no webhook that files a GitHub issue as a PageSpace task. If you want to see what happened, you look at GitHub.

## Good to know

- **Agent actions on GitHub show up as you.** A comment an agent posts on a PR is indistinguishable from one you typed — same username, same avatar, same audit trail. Plan accordingly.
- **OAuth scopes are broad, so restrict at the tool layer.** GitHub only offers a \`repo\` scope that grants full read and write on repos you can see. To keep an agent read-only, strip the write tools from its allow-list — there is no OAuth-level read-only variant.
- **It's an agent-driven integration.** No PR summaries render on pages, no issue cards in docs. All interaction happens through a chat asking an agent to do something.

## Related

- [AI in your Workspace](/docs/features/ai) — how agents call external tools under your identity.
- [AI Chat](/docs/page-types/ai-chat) — the per-page allow-list that decides which GitHub tools a given agent can use.
- [Drives & Workspaces](/docs/features/drives) — how visibility scopes (private / owned / all drives) line up with drive membership.
- [Sharing & Permissions](/docs/features/sharing) — the PageSpace-side rules that decide who can invoke an agent in the first place.
`;

export default function IntegrationGithubPage() {
  return <DocsMarkdown content={content} />;
}
