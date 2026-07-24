export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  content: string;
  author: string;
  date: string;
  readTime: string;
  category: string;
  featured?: boolean;
  image?: string;
}

export function formatDate(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00`);
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export const blogPosts: Record<string, BlogPost> = {
  "build-a-chat-app-on-pagespace": {
    slug: "build-a-chat-app-on-pagespace",
    title: "Turn Your PageSpace Docs Into a Support Bot",
    description:
      "Your help docs already live in PageSpace. With two connections, a chat API for the conversation and the SDK for your content, they become a support bot on your site and a help center your team runs, with every conversation saved back in PageSpace.",
    image: "/blog/support-bot/bot-answer.png",
    content: `
## What you'll have when you're done

A support bot on your website that answers customers from your own help docs, with every conversation saved back in PageSpace for your team to read or jump into. You build the chat box; PageSpace handles everything behind it: the AI, the instructions it follows, the search through your docs, and the record of every conversation.

Normally a support bot is a week of work that has nothing to do with support. You pick an AI model and pay to run it. You teach it how to answer and keep those instructions up to date. You build a way for it to search your help articles and pull up the right one, the part most teams find hardest. And you store every conversation somewhere your team can see it. If your help content already lives in a PageSpace drive, all of that is already done.

You connect to it in two ways, and both are worth knowing up front:

- **A chat API** runs the conversation. It works the same way most AI chat tools already do, so any chat box can talk to it. This powers the live bot.
- **The [SDK](/docs/features/sdk)** (a small set of ready-made code a developer plugs into your app) handles your content: reading, searching, and editing the docs the bot answers from. This powers the browsable help center and the admin your team uses to keep the docs current.

One drive sits behind both. Here is what that looks like.

## See it working

Everything in this guide runs in a small reference app we built on exactly those two connections. Three surfaces, one drive behind them.

Keep one thing in mind as you look: this is your own app, so it can look however you want. The screenshots below are one design we mocked up to show the pieces. Because PageSpace is only the backend, the chat box, the help center, and the admin are entirely your frontend: your layout, your branding, your fonts and colors, your components. Nothing about the look is locked to a PageSpace widget. You build the interface; PageSpace supplies the answers and the content behind it.

**Customers ask the bot.** A chat box on your site that answers straight from the docs in your drive, appearing word by word as the bot types:

![The public support bot on a website](/blog/support-bot/public-bot.png)

*The bot on your site is a PageSpace agent (the AI assistant that reads your docs and answers), working through the chat API. Your website only shows the chat box; the AI, its instructions, and the search through your docs all live in PageSpace.*

![The support bot answering a question from the docs](/blog/support-bot/bot-answer.png)

*Ask a real question and the bot finds the right help page and answers from it, with the actual steps. You never built the part that searches your docs; the agent reads your drive directly.*

**Customers browse the same docs.** The same pages the bot reads also become a clean, searchable help center customers can browse themselves:

![A browsable, searchable docs site built on the PageSpace SDK](/blog/support-bot/docs-browser.png)

*The docs are the single source of truth. The bot and the help center read from the exact same content, so they can never fall out of sync.*

**You manage the docs in your own admin.** The bot's knowledge is just those pages, so a support lead can edit an answer in your own admin screen:

![A custom docs admin built on the PageSpace SDK](/blog/support-bot/docs-admin.png)

*Edit an answer here and the next customer question is answered from the new version. No developer, no redeploy: the docs are the bot's knowledge, and updating them updates the bot.*

The help center and the admin above are built with that same **[SDK](/docs/features/sdk)**. Listing, reading, and searching your docs is a few lines, so a developer can build whatever interface you want on top:

\`\`\`ts
import { PageSpaceClient, StaticTokenProvider } from "@pagespace/sdk";

const ps = new PageSpaceClient({
  baseUrl: "https://pagespace.ai",
  auth: new StaticTokenProvider(process.env.PAGESPACE_TOKEN),
});

const { pages } = await ps.pages.list({ driveId, recursive: true, ls: true }); // the help-center list
const doc = await ps.pages.read({ operation: "read", pageId });                // one page to show
const hits = await ps.search.regex({ driveId, pattern: "reset password", searchIn: "content" }); // the search box
\`\`\`

And because the drive is a real PageSpace workspace, you can skip the custom admin entirely and manage everything natively in the app: edit the docs, adjust the bot, and read every customer conversation as a page your team can open.

![The same agent and its docs, managed natively inside PageSpace](/blog/support-bot/inside-pagespace.png)

*The agent, the docs it reads, and the threads it produces are all pages in one drive. A teammate can open any conversation and take over.*

Now let's build it.

## Set up the support agent

**1. Create the agent in your support drive.** An agent is an AI Chat page. Create one and keep the id it returns:

\`\`\`bash
pagespace pages create "Support Bot" AI_CHAT --drive <driveId> --json
# -> { "id": "<agentPageId>", "type": "AI_CHAT", ... }
\`\`\`

**2. Tell it how to answer, and let it read the drive.** An AI Chat page has a system prompt and a set of tools. Set the prompt so it behaves like support:

\`\`\`bash
pagespace agents config <agentPageId> --set systemPrompt="You are the support assistant for Acme. Answer only from the docs in this drive. Be concise and friendly. If the docs do not cover a question, say so and offer to hand off to a human. Never invent product behavior."
\`\`\`

A brand-new agent has no tools enabled, which means it cannot actually search or read the drive and will make things up. Turn on the read-only tools so it answers from your docs instead:

\`\`\`bash
pagespace agents config <agentPageId> --set enabledTools='["multi_drive_search","regex_search","glob_search","list_pages","read_page"]'
\`\`\`

Pick a specific model the same way if you want one (\`--set aiModel=<id>\`, and \`pagespace models list\` shows the options), or set all of this in the agent's settings tab in the app. Check your work with \`pagespace agents list --drive <driveId> --json\`: it shows the model, whether a system prompt is set, and the enabled tools.

If you would rather point and click, the same settings live on the agent page in PageSpace:

![The agent's enabled tools, configured in PageSpace](/blog/support-bot/agent-tools.png)

*Turn on the read-only search and read tools and nothing else. A support bot should answer from your docs, not write to them.*

![The agent's workspace context setting in PageSpace](/blog/support-bot/agent-context.png)

*Hand the agent the drive's page tree so it knows what documentation exists before it starts searching.*

**3. Create a key for your server.** The endpoint runs the agent's tools, which need edit access to the page, so create a key that inherits your own access to the drive (leave \`--role\` off). A plain \`member\` key is view-only on an agent page and would get a 403:

\`\`\`bash
pagespace keys create --drive <driveId> --name support-bot --show-token
# prints PAGESPACE_TOKEN=mcp_... once. Store it as PAGESPACE_TOKEN on your server, never in the browser.
\`\`\`

Scope the key to the drive that holds your public help docs and nothing sensitive. If the key cannot see a page, neither can the agent.

## Wire it into your site

**4. Call the agent exactly like OpenAI.** It speaks Chat Completions, so you change three things: the base URL, the key, and the model. The model is your agent, addressed as \`ps-agent://<agentPageId>\`:

\`\`\`ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://pagespace.ai/api/v1",
  apiKey: process.env.PAGESPACE_TOKEN, // the mcp_ token, server side only
});

const stream = await client.chat.completions.create({
  model: "ps-agent://<agentPageId>",
  stream: true, // the API only streams; stream: false is rejected
  messages: [{ role: "user", content: "How do I reset my password?" }],
});
\`\`\`

The agent answers with its own system prompt and runs its own tools on the server. It searches the drive, reads the right doc, and returns the answer, all inside the key's scope. This is the same credential the [SDK](/docs/features/sdk) and [CLI](/docs/features/cli) use.

**5. Stream it to the customer.** The response is an OpenAI stream, so a Next.js route handler that pipes it to the browser is a dozen lines:

\`\`\`ts
// app/api/support/route.ts
export async function POST(req: Request) {
  const { messages } = await req.json();

  const stream = await client.chat.completions.create({
    model: "ps-agent://<agentPageId>",
    stream: true,
    messages,
  });

  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) controller.enqueue(encoder.encode(delta));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}
\`\`\`

Your chat box sends the conversation so far to that route and shows the reply as it streams in, word by word. That is the bot.

## Every conversation lands in PageSpace

A support bot is only half done if the conversations vanish. Pass a \`conversation_id\` and the whole conversation is saved in PageSpace: every message is stored, it appears on the AI Chat page in the app, and your support team can read it or open the same thread and reply as a human.

Give each customer session its own \`conversation_id\`. Set \`client_manages_history: true\` so your app keeps control of the running history and the chat interface. With that flag set, PageSpace creates the thread the first time it is used, owned by your key, and stores every message under it, while your app stays in charge of the chat.

Both fields go on the same \`create\` call, right beside \`messages\`:

\`\`\`ts
const stream = await client.chat.completions.create({
  model: "ps-agent://<agentPageId>",
  stream: true,
  messages,
  conversation_id: conversationId,   // a fresh id you generate per customer session
  client_manages_history: true,      // your app owns the running history
});
\`\`\`

Those last two are extra fields in the request body. The OpenAI client sends them through as-is; they are not part of its built-in types, so a TypeScript app adds a small cast on the object. (Prefer to create threads up front? \`POST /api/v1/conversations\` with a \`drive_id\` returns an id you reuse.) To let a customer resume where they left off, read the stored messages back:

\`\`\`bash
curl https://pagespace.ai/api/v1/conversations/<conversationId> \\
  -H "Authorization: Bearer mcp_your_key_here"
# -> { "messages": [ { "role": "user", "content": "..." }, ... ] }
\`\`\`

Refill the chat box from those saved messages and the customer picks up mid conversation. A teammate can open the same thread in PageSpace and take over. The conversation is not trapped in your database. It is a page in the workspace.

## Before you make it public

This is the working bot, but not yet locked down for real public traffic. You do not have to build much more, but two things are on you before it goes live.

First, keep the token on your server. The \`mcp_\` key inherits your drive access, so it never belongs in the browser. Your route handler holds it and the customer only ever talks to your route. The examples above already do this.

Second, add rate limiting. The chat API does not limit how often each visitor can send messages. It caps how many calls run at once and stops when your credits run out, but nothing stops one visitor from sending request after request, and every request spends your drive's credits. On a public page that is an open door to drain your balance. Put a limit in the route that sits in front of the chat API: throttle by IP or session, cap messages per minute, and reject anything over the line before it reaches PageSpace. A few lines in the same route handler that already holds the token.

Look at everything you did not have to build: no AI model to choose and pay a separate vendor to run, no instructions to keep up to date in your code (they live on the agent page, editable by your support lead), no search system to build and maintain so the bot finds the right article (the agent reads your drive directly, since [the drive is the context](/blog/your-workspace-is-the-context)), and no database of past conversations (they are already pages in your workspace). You brought a chat box and a key. PageSpace brought the rest. The full technical reference is in the [Agent API docs](/docs/features/agent-api) and the [SDK docs](/docs/features/sdk).
`,
    author: "PageSpace Team",
    date: "2026-07-14",
    readTime: "7 min read",
    category: "Guide",
  },
  "usage-based-pricing-and-built-for-scale": {
    slug: "usage-based-pricing-and-built-for-scale",
    title:
      "Credits Replace Daily Limits: Pay for What You Use, Run the Models You Want",
    description:
      "PageSpace AI is now usage-based. Every plan gets a monthly pool of credits you spend however you like, paid plans unlock frontier models, and you can top up any amount from $5 to $500. Here's how it works, plus the infrastructure move that makes it scale.",
    image: "/blog/usage-based-pricing-and-built-for-scale.png",
    content: `
## Daily limits were a stopgap. We outgrew them.

When PageSpace was small, the simplest way to meter AI was a daily call count. Free got 50 calls a day, Pro got 200. Cross the line and you were done until midnight, even if every call that day was a one-line throwaway. It shipped fast and it was easy to understand. It was also a blunt instrument that didn't really scale, for you or for us.

A quick yes/no question and a ten-step research agent counted the same: one call. The number on the wall had nothing to do with the cost behind it. And we kept leaning into longer, more agentic work: agents that plan, call tools, and run for many steps on your behalf, where a single task can do the work of a hundred old "calls." Stack that on top of better, more expensive models and the call-count math fell apart. We could cap you harder or quietly eat costs we couldn't sustain, and neither is how you build something meant to last.

So we put our big-boy pants on. AI in PageSpace is now usage-based: a monthly pool of credits you spend on exactly what you use, priced on what each model actually costs. It's the model we should have started with. It's what lets us scale, and it's what lets us hand you genuinely better models instead of holding them back.

## Credits, not call counts

Every plan comes with a monthly pool of credits:

- **Free:** 5/month in credits
- **Pro:** 15/month in credits
- **Founder:** 50/month in credits
- **Business:** 100/month in credits

Each period adds to your balance — unused credits carry over, so nothing is lost. You spend it however you like: long agent runs, quick questions, voice, whatever the work needs. There's no per-day ceiling and no separate bucket for "standard" versus "heavy" usage. It's one balance, and you decide where it goes.

Each call draws from your balance based on what that model actually costs. No per-model multipliers, no rounding a fraction-of-a-cent call up to something absurd. A cheap model costs you a little and an expensive one costs you more — keeping the math simple is what lets us open up the best models from every major provider instead of charging extra for the good ones.

That's the whole point of usage-based pricing: what you pay tracks what you actually do.

## Pick the model that fits the job

Here's the part daily limits could never give you: when billing is usage-based, model choice opens up.

**Free** runs on fast, capable standard models: GPT-5.3 Chat by default, plus Claude Haiku 4.5, Gemini 3.5 Flash, and the GPT-5.4 mini and nano variants. They're quick, they're cheap, and your credits stretch a long way across them.

**Pro, Founder, and Business** unlock the frontier. Spend your credits on Claude Opus 4.8, the GPT-5.5 family, Gemini 3.1 Pro, whatever the task calls for. A throwaway question doesn't need Opus, so reach for a light model and your credits last. A gnarly refactor or a long research synthesis is worth the spend, so reach for the flagship. You make that trade-off per task instead of having it made for you.

## When you run low

If your balance runs out before your next renewal, you're not locked out until tomorrow. Top up.

You can add **any amount from $5 to $500** in one click, or grab a quick-pick pack of $10, $25, or $50. Top-up credits never expire, so anything you add during a busy week carries over.

Run low, top up, keep going. No more waiting out a daily reset.

## Built to scale

Pricing is only half of this. PageSpace now runs on scalable, modern infrastructure built to grow:

- **Built to scale out.** Storage and request handling are stateless, so PageSpace can spread across many machines and bring more online as demand rises. Capacity grows with usage instead of capping it.
- **Faster file delivery.** Your uploads and attachments serve straight from object storage instead of round-tripping through a single app server. Less waiting, more consistent speed.
- **Bigger uploads, including video.** With files on object storage instead of one machine's disk, upload limits go up and video is in.

This is the foundation the credit model needs. Usage-based pricing only works if the platform can actually absorb the usage, and now it can.

## What's next

**Agents that run real code.** AI agents will execute code in isolated, sandboxed containers right inside your workspace. Not "here's a snippet to copy," but the agent actually running it in a throwaway sandbox. More on that as it lands.

## What doesn't change

Credits only meter AI. Your documents, tasks, channels, files, and collaboration cost nothing and work exactly as before. Nothing about how you and your team work together is changing.

Open your plan to see your balance, pick your models, and top up when you want. Pay for what you use, run what you need.
    `,
    author: "Jono",
    date: "2026-06-03",
    readTime: "6 min read",
    category: "Product",
    featured: true,
  },
  "your-workspace-is-the-context": {
    slug: "your-workspace-is-the-context",
    title:
      "Your Workspace Is the Context: How PageSpace Teaches AI Where It Is",
    description:
      "Most AI tools dump flat text into a prompt. PageSpace gives AI a map — a tree structure that encodes location, hierarchy, and meaning. Here's how workspace organization becomes AI understanding.",
    image: "/blog/workspace-is-the-context.png",
    content: `
## The Problem with Flat Context

Most AI tools work like this: take a blob of text, shove it into the system prompt, hope the model figures it out.

There's no structure. No location. No hierarchy. The AI doesn't know where it is, what's around it, or how the information relates to anything else. It's reading a book with no table of contents, no chapters, no page numbers.

You end up doing the work the AI should be doing — explaining what project this is, what files are relevant, what conventions apply. Every session. Every time.

The problem isn't the AI's capability. It's that nobody gave it a map.

## The Tree as a Semantic Structure

PageSpace organizes everything in a page tree. Folders, documents, AI agents, chat channels, spreadsheets, canvases — they all live in a hierarchical structure you design.

This isn't just a UI convenience. The tree *is* the context model.

Where a page lives tells the AI what it means. A document called "API Design" under \`/Engineering/Backend/\` carries different weight than a document with the same name under \`/Archive/Old Drafts/\`. The path encodes intent, scope, and relevance — without you writing a single annotation.

When you organize your workspace, you're not just tidying up for yourself. You're teaching the AI how your work is structured.

## Breadcrumb Path Injection

When you chat with an AI agent in PageSpace, the system builds a breadcrumb path from the page's position in the tree and injects it directly into the system prompt.

Here's what the AI actually receives — the real \`PAGE CONTEXT\` block from the system prompt builder:

\`\`\`
PAGE CONTEXT:
• Location: /engineering/backend/api-design
• Type: DOCUMENT
• Path: Engineering > Backend > API Design
• When users say "here", they mean this page
\`\`\`

The AI now knows it's looking at an API design document inside the backend section of the engineering workspace. When you say "here," it means something specific. When you say "update this," the AI knows exactly what "this" refers to.

No ambiguity. No guessing. The tree position resolves it.

## Workspace Structure as a Map

Beyond knowing its own location, the AI can receive the entire workspace tree — formatted as a visual hierarchy that mirrors the structure you built.

Here's the real format, generated from PageSpace's tree formatter:

\`\`\`
├── 📁 Engineering
│   ├── 📄 Architecture Overview
│   ├── 🤖 Code Review Agent
│   └── 📁 Backend
│       ├── 📄 API Design
│       └── 📄 Database Schema
└── 📁 Product
    ├── 📄 Roadmap
    └── 💬 Team Discussion
\`\`\`

The AI can see sibling pages, parent folders, and the full organizational context. It knows that "Architecture Overview" and "Code Review Agent" sit alongside the "Backend" folder. It can decide what to read based on structure, not guesswork.

When someone asks "what do we know about the backend?" the AI doesn't search blindly — it looks at the Backend folder, sees what's there, and reads what's relevant. The tree tells it where to look.

## Inline Instructions — What the AI Knows About Itself

Beyond location, the AI receives contextual rules that define how it should behave in this specific context. These come from PageSpace's inline instruction system:

\`\`\`
CONTEXT:
• Current location: "API Design" [DOCUMENT] at /eng/backend/api-design in "Engineering"
• DriveSlug: eng, DriveId: abc123
• When user says "here" or "this", they mean this location
• Explore current drive first (list_pages) before other drives
\`\`\`

The AI also receives page type documentation — what each type can do, what operations make sense. It knows that a DOCUMENT page supports rich text editing and content updates. It knows that a SPREADSHEET page has structured data. It knows that an AI_CHAT page is a conversation.

Add workspace-level rules — your team's conventions, writing style preferences, tool restrictions — and the AI's behavior becomes specific to where it's operating, not generic across all contexts.

## The Tools — How the AI Explores

PageSpace doesn't just give the AI a static context dump. It gives the AI real tools to explore your workspace actively:

- **\`list_pages\`** — Browse the tree structure, see what's inside any folder
- **\`read_page\`** — Read the full content of any page in the workspace
- **\`regex_search\`** — Search content across pages with regex patterns, returns matches with line numbers and semantic paths
- **\`glob_search\`** — Find pages by path patterns like \`**/meeting-notes/*\` or \`engineering/**\`
- **\`multi_drive_search\`** — Search across all workspaces at once when the answer might live somewhere else
- **\`ask_agent\`** — Call another AI agent in the workspace, delegating specialized questions to agents with domain expertise

The AI doesn't just receive context passively — it can actively navigate. The tree gives it a map. The tools let it move through it. When the AI needs to find related documents, it doesn't ask you to paste them. It searches, reads, and synthesizes on its own.

## Page Agents: Context-Aware AI in the Tree

Page agents are AI_CHAT pages that live in the tree alongside your documents. They're not separate from your workspace — they're part of it.

Each agent can be configured with:

- **Custom system prompts** — specific instructions for what this agent knows and how it should behave
- **Tool permissions** — allow only read tools for a research agent, or write tools for an editor agent
- **Page tree visibility** — see only children of the current folder, or the full drive structure
- **Drive prompt inclusion** — inherit workspace-level instructions and conventions

Here's why the tree matters for agents: an agent nested under \`/Engineering/Backend/\` naturally has context about backend engineering. Its position in the tree encodes its purpose. A "Code Review Agent" sitting next to "Architecture Overview" and "API Design" inherently understands its scope — it's there to review code in the context of that architecture and those APIs.

You don't need to write elaborate prompts explaining what the agent should focus on. The tree already told it.

## The Composable Prompt

All of this comes together in how PageSpace assembles the final system prompt. It's not one monolithic block — it's built from discrete, composable layers:

1. **Core role definition** — the base personality and capabilities
2. **User personalization** — your bio, writing style, custom rules
3. **Location context** — breadcrumbs, drive info, page type
4. **Workspace structure** — the tree, visible as a map
5. **Inline instructions** — contextual rules for this specific location
6. **Timestamp context** — current date, time, and timezone
7. **Agent awareness** — list of other agents available to consult

Each layer is independently cacheable. Each is determined by the tree position — different locations produce different prompts. An agent in the Engineering folder gets engineering context. An agent in Product gets product context. Same underlying model, different understanding.

The tree isn't just organizing your files. It's programming the AI.

## Why This Matters

AI that knows where it is makes better decisions.

It doesn't need you to explain the project structure — it can see the tree. It doesn't need you to point at related documents — it can find them. It understands that a page under "Architecture Decisions" is different from a page under "Meeting Notes" even if they mention the same topic.

Structure is meaning. A flat list of documents is just noise. A tree is a semantic model — every folder boundary, every nesting level, every sibling relationship carries information about how your work fits together.

When you organize your PageSpace workspace, you're not doing busywork. You're building the context model that makes your AI actually useful. The workspace *is* the prompt.

Your workspace is the context. Make it a good one.
    `,
    author: "Jono",
    date: "2026-02-17",
    readTime: "9 min read",
    category: "Product",
    featured: false,
  },
  "pagespace-as-memory-for-coding-agents": {
    slug: "pagespace-as-memory-for-coding-agents",
    title: "Using PageSpace as Memory for Your Coding Agent",
    description:
      "Coding agents are stateless. Every session starts from scratch. Here's how to give them persistent memory with PageSpace and MCP — including cloud agents that intelligently retrieve the right context.",
    image: "/blog/pagespace-memory-coding-agents.png",
    content: `
## The Problem: Your Coding Agent Has Amnesia

Every time you start a new session with your coding agent, it forgets everything. The architecture decisions you explained yesterday. The conventions your team agreed on last week. The debugging session where you finally figured out that weird race condition.

You re-explain the same context over and over. You paste the same docs into chat. You point at the same files and say "remember, we do it this way."

CLAUDE.md files help — they give your agent a starting point. But they're static, local to one repo, and limited in what they can capture. They're a sticky note on the monitor, not a knowledge base.

What if your coding agent could actually remember?

## What If Your Agent Had a Knowledge Base?

Imagine a persistent, organized workspace your coding agent can read from, write to, and search across. Not files buried in your repo — a structured knowledge system that:

- **Persists across sessions** — context survives after you close your terminal
- **Works across projects** — your React conventions apply whether you're in the frontend repo or the monorepo
- **Shares across machines** — same knowledge base on your laptop and your CI server
- **Stays organized** — not a flat dump of text, but a hierarchy of pages, folders, and agents

That's what PageSpace gives your coding agent.

## PageSpace + MCP: The Connection

PageSpace publishes an MCP server — \`pagespace-mcp\` on npm — that exposes your knowledge base to any coding agent that supports the Model Context Protocol.

Install it, point it at your PageSpace instance with a token, and your coding agent gets direct access to search, read, and write pages in your workspace.

MCP is the protocol. PageSpace is the memory.

## Setup

Add PageSpace to your coding agent's MCP configuration:

\`\`\`json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "pagespace-mcp@latest"],
      "env": {
        "PAGESPACE_API_URL": "https://your-instance.pagespace.ai",
        "PAGESPACE_AUTH_TOKEN": "your-mcp-token"
      }
    }
  }
}
\`\`\`

Generate an MCP token from your PageSpace workspace settings. The token is scoped to a specific drive, so you control exactly what your agent can access.

That's it. Your coding agent can now search your knowledge base, read pages, create new ones, and update existing content — all through natural tool calls.

## The Real Differentiator: Cloud Agents

Here's where PageSpace goes beyond "document storage your agent can read."

PageSpace has **page agents** — cloud AI agents with custom instructions that live inside your knowledge base. They're not just documents. They're intelligent retrieval and processing layers that sit between your coding agent and your knowledge.

When your coding agent calls PageSpace via MCP, it can talk to these page agents. That means:

**Smart retrieval, not keyword search.** Instead of your coding agent trying to guess which document has the answer, it can ask a page agent: "What are our conventions for error handling in API routes?" The page agent knows the knowledge base, understands the question, and returns the relevant context.

**Summarization on demand.** A page agent can digest a 20-page architecture doc into the three paragraphs your coding agent actually needs for its current task.

**Knowledge base maintenance.** Page agents can organize incoming information. Your coding agent writes a raw note about a decision you made — a page agent files it properly, links it to related docs, and keeps the knowledge base clean.

**Shared context across agents.** Multiple coding agents — yours, your teammate's, your CI pipeline's — all read from and write to the same workspace. Page agents ensure consistency. One source of truth, many consumers.

This is the difference between giving your agent a filing cabinet and giving it a research assistant.

## What to Put in Your Knowledge Base

Start with what you find yourself re-explaining to your coding agent:

- **Architecture decisions and rationale** — why you chose that database, why the auth works that way, why you split that service
- **Coding conventions and patterns** — how you structure components, naming rules, error handling patterns, test conventions
- **API documentation** — internal APIs, external integrations, authentication flows
- **Debugging playbooks** — "when X happens, check Y" knowledge that's hard to capture in code comments
- **Meeting notes and decisions** — the context behind the code, not just the code itself
- **Project roadmaps** — what's planned, what's in progress, what's blocked and why

The key insight: anything you'd explain verbally to a new team member belongs in your knowledge base. Your coding agent is a new team member every single session.

## Security

Giving an AI agent access to your knowledge base requires trust in the access model:

- **Drive-scoped tokens** — each MCP token is scoped to a single drive. Your agent sees only what you explicitly share
- **Audit logging** — every read and write through MCP is logged
- **Fail-closed permissions** — if the token doesn't grant access, the request is denied. No fallbacks, no defaults

You control the boundary. The agent works within it.

## Getting Started

1. Create a PageSpace account and set up a drive for your project knowledge
2. Add your architecture docs, conventions, and patterns as pages
3. Create page agents with instructions tailored to your workflow
4. Generate an MCP token and add the config to your coding agent
5. Start a session and ask your agent to check the knowledge base

Your coding agent just got a memory. Use it.
    `,
    author: "Jono",
    date: "2026-02-17",
    readTime: "8 min read",
    category: "Guide",
  },
  "google-calendar-sync-setup": {
    slug: "google-calendar-sync-setup",
    title: "How to Connect Google Calendar and Let AI See Your Schedule",
    description:
      "A step-by-step guide to connecting Google Calendar with PageSpace. Two-way sync, calendar selection, and how to use AI agents that can actually check your availability and schedule meetings.",
    image: "/blog/google-calendar-sync-setup.png",
    content: `
## Why This Matters

Your AI agent can read your documents, search your workspace, write content, and manage tasks. It has no idea what's on your calendar.

Every scheduling suggestion is a guess. Every prioritization ignores the meeting you have in 30 minutes. Every "when should we do this?" turns into an alt-tab to Google Calendar and a manual relay back.

Connecting Google Calendar to PageSpace fixes that. Your events sync in, your AI agents get real tools to query your schedule and create events that push back to Google. This guide walks through setup.

## Step 1: Connect Your Google Account

Open **Settings** in PageSpace. Under integrations, find **Google Calendar** and click **Connect Google Calendar**.

You'll be redirected to Google's consent screen. PageSpace requests read and write access to your calendars. Write access is needed so AI-created events can push back to Google.

Grant the permissions. Google redirects you back to PageSpace. You'll see a green "Connected" badge with your Google email on the settings page.

If the flow fails, PageSpace tells you why. Most common: you clicked cancel ("Access denied") or waited too long to complete it ("State expired"). Click Connect again.

## Step 2: Pick Your Calendars

Once connected, PageSpace fetches your available Google calendars and displays them as a checklist. Your primary calendar is selected by default.

You'll see every calendar on your Google account. Primary, work, holidays, shared team calendars, that "Birthdays" calendar you forgot you had. Each one shows its color dot and name.

Check the ones you want to sync. Uncheck the ones you don't. Changes save immediately, and PageSpace triggers a sync for any newly selected calendar so events appear right away.

You need at least one calendar selected. If you try to uncheck all of them, PageSpace blocks it.

## Step 3: First Sync

After connecting, PageSpace runs an initial sync automatically. It pulls events from the past 30 days through the next 90 days. This gives your AI agents enough historical context for patterns and enough future context for scheduling.

The first sync might take a few seconds depending on how many events you have. After that, sync is incremental. Only changed events transfer. Google sends push notifications to PageSpace in real time when events change, and a background job polls every 15 minutes as a fallback. Between the two, your PageSpace calendar stays current without you doing anything.

You can always hit **Sync Now** on the settings page to force an immediate sync. The page shows your last sync time and how many events are currently synced.

## Two-Way Sync

Events from Google appear in your PageSpace calendar. Events created in PageSpace push back to Google. A colleague reschedules through Google, PageSpace picks it up. Your AI agent creates a "Project Review" event, it shows up on your phone.

When an agent schedules a meeting, it's not creating a PageSpace-only event nobody else can see. It's a real calendar event that lands in Google Calendar for every attendee.

## What Your AI Can Do With Your Calendar

Once connected, your AI agents get calendar tools. Not a read-only view. Real tools with real parameters.

**See your schedule.** The agent lists events in any date range across all synced calendars. "What do I have this week?" gets a real answer.

**Check availability.** The agent queries a date range and gets back free time slots. It respects working hours. It merges overlapping events. A meeting from 2:00 to 3:00 and a call from 2:30 to 3:30 show as one busy block, not two.

**Schedule meetings.** The agent creates events with title, time, duration, location, recurrence, attendees, and visibility. The event pushes to Google Calendar automatically.

**Manage the full lifecycle.** Update events, cancel them, RSVP on your behalf, add or remove attendees.

These are the tools an executive assistant would need.

## Scheduling Example

You're in a PageSpace AI chat working on a project, and you type:

*"Schedule a 30-minute project review with the team for sometime Thursday afternoon. Find a slot that works."*

The agent calls \`check_calendar_availability\` for Thursday afternoon. Finds 2:00 to 2:30 open. Calls \`create_calendar_event\` with the title, time slot, and your workspace members as attendees. The event syncs to Google Calendar. Everyone sees it on their phone. You never left the chat.

That's the difference between a calendar display widget and calendar tools.

## Time-Triggered Agents

Calendar events can trigger AI agents to run at event time.

When you create an event in PageSpace, you can attach an AI agent page and a prompt. When the event arrives, the agent wakes up with full event context and executes.

Practical example: create a recurring event, "Weekly Metrics Review," every Monday at 9am. Attach your analytics agent with instructions to read the latest data pages in your workspace and write a summary document. Every Monday morning, the agent runs. It reads live data. It writes the report. No human involvement. The summary is always current because the agent reads what exists now, not a cached snapshot.

Another one. Project deadline is Friday. Create an event, "Pre-deadline check," Thursday at 4pm. Attach a project agent with instructions to review the open tasks and post a status summary. Thursday afternoon, the agent runs a check for you while you're still in meetings.

The trigger system checks drive access, agent page existence, and your available credits before executing. If any check fails, nothing runs and nothing breaks.

The calendar becomes a scheduler for AI work.

## Security and Permissions

AI calendar tools go through the exact same permission system as every other tool in PageSpace. If you can't see an event, your AI agent can't either. If you're not a member of a drive, calendar queries for that drive return nothing.

Tokens are encrypted at rest. Webhook authentication is cryptographically signed. Token refresh happens automatically before expiration so sync never fails mid-request.

Your calendar data is encrypted, never shared with third parties, and you can disconnect at any time from the settings page. Disconnecting revokes your token on Google's side and stops all sync.

Connect your calendar. Let your AI see your schedule.
    `,
    author: "Jono",
    date: "2026-04-15",
    readTime: "5 min read",
    category: "Guide",
  },
  "browser-style-tabs": {
    slug: "browser-style-tabs",
    title: "Tabs That Work Like Your Browser (Because They Should)",
    description:
      "PageSpace uses browser-style tabs — Alt+T to open, Ctrl/Cmd+1–9 to jump, Ctrl+Tab to cycle. Here's why we chose browser semantics over VS Code's, and how tabs become the escape hatch from the navigation tax of nested folders.",
    image: "/blog/browser-style-tabs.png",
    content: `
## The Navigation Tax

Every time you drill into a nested folder to find a page, you pay. It's a small tax: one click, two clicks, a hover, another click. But in an AI-assisted workflow, where you're jumping between a spec, a task list, an AI chat, and a meeting doc all within the same 20-minute stretch, those clicks compound.

The usual fixes — better search, smarter folders, tags — treat the symptom. Tabs treat the cause.

## Browser-Style, Not VS Code-Style

There's a meaningful difference between how browsers and VS Code handle tabs, and it comes down to what you can predict.

In your browser, Ctrl+1 always goes to the first tab. Ctrl+W always closes the current one. Ctrl+Tab cycles forward. You don't have to think about it — that pattern is already in your muscle memory.

VS Code tabs work differently. The same key bindings behave differently depending on panel state, focus, and whether you're in an editor or terminal. That overhead is fine if you live in VS Code all day. It's not fine when you're switching between a browser, a notes app, and a knowledge base every few minutes.

PageSpace chose browser semantics deliberately. The shortcuts you already know work exactly the way you already expect them to.

## The Shortcuts

**Alt+T** opens a new tab. (On macOS, this key combination normally produces a \`†\` character — PageSpace handles the translation under the hood.)

**Ctrl/Cmd+1 through Ctrl/Cmd+9** jump directly to tabs one through nine. Hover over any of the first nine tabs and you'll see the number appear, so you always know which key to press. These shortcuts work even when your cursor is inside an input field.

**Ctrl+Tab** and **Ctrl+Shift+Tab** cycle forward and backward through your open tabs.

**Ctrl/Cmd+W** closes the current tab.

Mouse users aren't left out: middle-click closes a tab, and right-clicking any tab gives you a context menu with close, close others, close to right, and pin.

## Tabs as Persistent Context

The most useful thing about tabs isn't navigation speed. It's persistence.

Open a spec in Tab 1, an AI chat in Tab 2, and a task list in Tab 3. Now Ctrl+1, Ctrl+2, Ctrl+3 moves you between those three surfaces instantly, without re-navigating the folder tree each time. The views stay exactly where you left them.

In an AI-heavy workflow, this matters more than it used to. You're not reading a document linearly and closing it. You're iterating — reading, asking a question, checking a task, going back, refining. Each surface is live context you return to repeatedly. Tabs keep that context open.

## One More Thing: Pinning

If a tab is always open — your daily notes page, a running AI chat, a project tracker — pin it. Pinned tabs sit at the left of the bar, don't have a close button, and persist across sessions.

## The Escape Hatch

Folders are good for organizing. They're not good for navigating under time pressure.

When you're deep in a task, you shouldn't have to remember that your meeting notes are three levels under \`/Team/Engineering/2026/\`. They should be one keypress away. Tabs are that escape hatch. A flat, keyboard-native layer above the folder hierarchy that keeps your most active context instantly reachable.

Press **Alt+T** to open one now.
    `,
    author: "Jono",
    date: "2026-05-08",
    readTime: "3 min read",
    category: "Product",
  },
  "ai-versioning-safety": {
    slug: "ai-versioning-safety",
    title:
      "The Undo Button for AI: How Three Layers of Versioning Make Full Agent Access Safe",
    description:
      "AI needs write access to be useful, but write access without a safety net is reckless. PageSpace builds versioning and rollback so deep that any AI change can be reversed instantly — at the page, conversation, or entire workspace level.",
    image: "/blog/ai-versioning-safety.png",
    content: `
## The Access Dilemma

There's a tension at the center of every AI-powered workspace tool, and most of them pretend it doesn't exist.

If your AI can only read your content, it's a search engine with a personality. It can summarize, answer questions, maybe find a document you forgot about. Useful, but limited. You still do all the actual work — creating pages, editing text, organizing files, updating spreadsheets.

If your AI can write, edit, create, and delete — now it's a collaborator. It can draft documents, reorganize your workspace, update task lists, edit code, build out entire project structures. That's where the real productivity gains live. An AI that can only look at your work is an observer. An AI that can change your work is a partner.

But write access is terrifying.

What happens when the AI misunderstands your request and rewrites your carefully crafted architecture document? What happens when it deletes pages it shouldn't have touched? What happens when a multi-step AI operation goes sideways halfway through — three pages updated, two created, one renamed — and you need to get back to where you were?

Most platforms pick a side. Either they restrict the AI to keep things safe (and lose most of the value), or they hand over full access and hope their model is good enough to not break things (and it isn't, always).

There's a third option: give the AI real tools, and make everything it does reversible.

## What "Reversible" Actually Requires

Saying "we have version history" isn't enough. A basic version history that saves a copy every time you hit save doesn't solve the AI problem.

AI doesn't edit like humans do. A human opens a document, reads it, makes a few changes, saves. An AI agent might update five pages in a single conversation turn. It might create new pages, edit existing ones, and reorganize the tree — all in response to a single prompt. The changes are fast, distributed across multiple resources, and linked by conversational context that a simple version timeline knows nothing about.

To make AI actions truly reversible, you need versioning that understands three things:

1. **What changed on each individual page** — so you can restore a single page without affecting everything else
2. **What the AI did across an entire conversation** — so you can undo a multi-page operation as one atomic action
3. **What your entire workspace looked like at a point in time** — so you can recover from anything, no matter how many changes were made

PageSpace builds all three.

## Layer 1: Page Versions — The Automatic Snapshot

Every time a page is modified in PageSpace, a version is created. This happens whether a human or an AI made the change. But here's the detail that matters for AI safety: the system tags versions differently depending on who initiated the edit.

When a human edits a page, the version source is tagged as \`auto\`. When an AI agent edits a page, the version source is tagged as \`pre_ai\`.

This isn't a label for display purposes. It's a first-class concept in the database schema — a dedicated enum value that the entire versioning system understands. The system knows, at the data level, that this version exists because an AI was about to change something.

Why does this matter? Because when you're looking at a page's version history, you can see exactly where the AI intervened. You can see the state of the page immediately before the AI touched it. And you can restore to that exact point with one click.

Each version captures:

- **The full page content** — stored with a SHA-256 content reference, optionally compressed for large pages
- **The content format** — whether it's rich text, markdown, JSON, or raw HTML
- **A state hash** — a computed fingerprint of the page's complete state (title, content, position, settings), so the system can detect if the page has been modified since the version was created
- **The page revision number** — a monotonically increasing counter that detects concurrent edits

Versions are retained for 30 days by default. If a version is important — say, it's the last known-good state before a major AI-driven rewrite — you can pin it, and it's exempt from expiration.

This isn't "undo" in the Ctrl+Z sense. It's a complete, content-addressable snapshot of every page state, with AI changes explicitly marked as a distinct source.

## Layer 2: Conversation Undo — Reversing What the AI Did

Page versions let you restore individual pages. But AI agents don't just edit one page at a time.

In a single conversation, an AI agent in PageSpace might create a new document, edit an existing one, update a spreadsheet, rename a page, and move something into a different folder. Each of those actions creates its own page version and activity log entry. But from the user's perspective, those five changes were one thing: "the AI did what I asked."

If the result isn't what you wanted, you don't want to manually find and revert five separate page versions. You want to undo everything the AI did from that point forward.

That's what conversation undo does.

When you trigger an undo on any message in a PageSpace AI conversation, the system finds every change that the AI made at or after that message. It traces the connection through the conversation ID that's stamped on every activity log entry — every page create, update, delete, rename, and move that the AI performed during that conversation.

You get two options:

**Messages only** — Remove the conversation messages from that point forward (soft-delete, not permanent destruction). The AI's changes to pages stay in place. Use this when the AI said something unhelpful but the actual edits were fine.

**Messages and changes** — Remove the messages AND roll back every change the AI made to your workspace. Every page edit reverted. Every page creation undone. Every rename reversed. All of it, atomically, in a single database transaction.

Before any of this executes, you get a preview. The system shows you exactly how many messages will be removed, exactly which pages and activities will be affected, and whether any of those pages have been modified since the AI touched them (conflict detection). If someone else — or you — made additional edits on top of the AI's changes, the system warns you. You can force the rollback if you want, but you'll know what you're overriding.

This isn't just "go back to a previous version." This is "identify every side effect of a multi-step AI operation and reverse all of them as one unit."

## Layer 3: Drive Backups — The Full Workspace Snapshot

Pages and conversations are fine-grained. But sometimes you need the nuclear option.

Maybe you handed an AI agent a broad instruction and it reorganized half your workspace. Maybe you're about to let a new AI agent loose on your knowledge base and you want a checkpoint first. Maybe it's Tuesday and you just want a backup.

Drive backups capture everything:

- **Every page in the workspace** — including content, metadata, and tree position (you can optionally include trashed pages too)
- **All permissions** — who has access to what, at what level
- **All members and their roles** — the full team structure
- **All files** — attachments, uploads, everything stored in the drive

Backups can be created manually (click a button), on a schedule (automated), or automatically before a restore operation (so restoring from a backup doesn't destroy your current state — the system snapshots what you have before overwriting it).

Each backup records page count, total content size, custom labels, and an optional reason field. You can annotate your backups: "Before letting the new research agent run" or "Pre-migration checkpoint."

This is the "I don't know exactly what went wrong but I need to get back to last Thursday" layer.

## The Audit Trail — Knowing Exactly What Happened

Versioning lets you go back. The audit trail lets you understand what happened in the first place.

Every action an AI takes in PageSpace is logged with full attribution:

- **Which AI provider and model** performed the action (not just "AI did this" — you know it was Claude 3.5 Sonnet, or GPT-4, or whatever model you're using)
- **Which conversation** the action was part of — linking the change back to the exact chat where you gave the instruction
- **What changed** — previous values and new values for every modified field
- **State hashes before and after** — cryptographic proof of what the page looked like before and after the change
- **The agent chain** — if a sub-agent was involved (one AI agent delegating to another), the full chain of delegation is recorded

This matters for teams. When three people are using AI agents in the same workspace, and someone notices a document looks different, the audit trail tells you which agent changed it, which conversation initiated it, and which user was driving that conversation. No ambiguity. No "the AI did it" with no further details.

## Permission Checks Still Apply

A common fear with AI agents is that they'll access things they shouldn't — reading private documents, editing pages in someone else's project, deleting things outside their scope.

In PageSpace, AI agents go through the exact same permission system as human users. Every single tool call — create, edit, delete, rename, move — checks permissions before executing.

If a user doesn't have edit access to a page, their AI agent doesn't either. If a drive is restricted to certain members, an AI agent operating on behalf of a non-member gets denied. There's no backdoor, no elevated privilege, no "the AI needs access so we'll skip the check."

The permission functions are centralized — the same code path that validates a human's edit request validates the AI's. One system. One set of rules. Whether you're clicking a button or the AI is calling a tool, the access check is identical.

## Why This Approach Beats the Alternatives

**Restricting AI to read-only** means you're leaving most of the value on the table. An AI that can't actually do things for you is an expensive search box. You still write every document, organize every folder, update every spreadsheet yourself. The AI watches.

**Giving AI full access with no safety net** works until it doesn't. And when it doesn't, the cost is high — lost content, broken organization, hours of manual recovery. The more powerful the AI, the more damage a single bad instruction can cause. "Just be careful with your prompts" is not a safety strategy.

**Making AI actions reversible at every level** is the approach that lets you actually use AI for real work without anxiety. You don't need to craft the perfect prompt. You don't need to review every change before it's made. You give the AI an instruction, see what it does, and if the result isn't right, you roll it back — one page, one conversation, or the entire workspace.

The safety isn't in preventing the AI from acting. It's in making every action undoable.

## What This Looks Like in Practice

You're working on a product launch. You ask your AI agent to draft documentation for three new features across three separate pages.

The AI creates the pages, writes the content, organizes them under the right folder. Each page gets a \`pre_ai\` version snapshot automatically. Every action is logged with the conversation ID, the model used, and the full before/after state.

You review the drafts. Two are great. One completely missed the point.

You have options. You can restore that one page to its pre-AI state using the page version history. Or if the AI also made structural changes you don't like — moved things around, renamed the folder — you can undo the entire conversation, reverting every change the AI made in that session. Or if you realize this after a week of additional work and just want to grab the pre-AI content from that one page, the version is still there, tagged and searchable.

At no point did you lose anything. At no point were you at the mercy of the AI getting it right the first time.

## The Uncomfortable Truth About AI Access

Here's what the industry doesn't want to talk about: AI models will make mistakes. They'll misinterpret instructions. They'll take actions you didn't intend. This isn't a bug that will be fixed in the next model release — it's an inherent property of working with systems that interpret natural language.

The question isn't whether your AI will ever do the wrong thing. It's what happens when it does.

If the answer is "you lose your work" or "you spend an hour manually fixing things" — that's a platform problem, not an AI problem. The model will get better over time. But even a perfect model operating on an ambiguous instruction will sometimes produce the wrong result.

The platforms that win won't be the ones with the most powerful AI. They'll be the ones where using powerful AI is safe. Where you can give an AI agent real tools — create, edit, delete, reorganize — and know that no matter what happens, you can get back to where you were.

That's what three layers of versioning gets you. Not a restriction on what AI can do. A guarantee that whatever it does can be undone.
    `,
    author: "Jono",
    date: "2026-04-10",
    readTime: "10 min read",
    category: "Product",
  },
};
