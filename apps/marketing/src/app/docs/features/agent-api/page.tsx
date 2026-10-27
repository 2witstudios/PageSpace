import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Agent API",
  description: "Call any PageSpace agent as an OpenAI-compatible Chat Completions endpoint — the same mcp_ key, your agent's system prompt and tools, running server-side. The backend for a chat app.",
  path: "/docs/features/agent-api",
  keywords: ["Agent API", "OpenAI-compatible", "chat completions", "ps-agent", "chat app backend", "developers", "@pagespace/cli"],
});

const content = `
# Agent API

Every PageSpace agent — any AI Chat page — is also an OpenAI-compatible endpoint. Point anything that speaks the OpenAI Chat Completions format at an agent and it answers with **its own system prompt and its own tools**, run server-side under your permissions. That is the whole backend for a chat app: you bring the UI, PageSpace brings the model, the context, and the tools.

It shares credentials with the rest of the developer surface — the same \`mcp_\` key does inference — so [the CLI](/docs/features/cli) mints it and [the SDK](/docs/features/sdk) and this API consume it.

## The endpoint

- **Base URL** — \`https://pagespace.ai/api/v1\`
- **API key** — a drive-scoped key (\`mcp_...\`) from \`pagespace keys\` or **Settings > MCP**, minted with edit access (an inherit key, created without \`--role\`). Keep it server-side.
- **Model** — \`ps-agent://<pageId>\`, the id of the AI Chat page to run. Copy it from the agent's settings tab, or list every agent a key can reach with \`GET /api/v1/models\`.

Because it is the OpenAI Chat Completions shape, the OpenAI SDKs work unchanged — you only swap the base URL and key.

\`\`\`ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://pagespace.ai/api/v1",
  apiKey: process.env.PAGESPACE_KEY, // an mcp_ key, kept server-side
});

const stream = await client.chat.completions.create({
  model: "ps-agent://<pageId>",
  stream: true, // required
  messages: [{ role: "user", content: "Summarize this drive's latest notes." }],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
\`\`\`

The same call with curl:

\`\`\`bash
curl https://pagespace.ai/api/v1/chat/completions \\
  -H "Authorization: Bearer mcp_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "ps-agent://<pageId>",
    "stream": true,
    "messages": [{ "role": "user", "content": "Summarize this drive'\\''s latest notes." }]
  }'
\`\`\`

## It is an agent, not a bare model

The page you name in \`model\` runs as the agent you configured, so each request comes with:

- **its system prompt** — whatever that AI Chat page is set up to be;
- **its tools, executed server-side** — it searches the drive, reads pages, and writes back on its own, and returns the result; and
- **only the tools it has enabled** — a bare agent starts with none and cannot reach the drive; enable read (and, if you want, write) tools on the agent page, or with \`pagespace agents config <pageId> --set enabledTools='["multi_drive_search","read_page"]'\`; and
- **your permissions and the key's scope** — it can only reach what the key can reach. If you cannot see a page in the app, the agent cannot either.

Because the agent runs write tools on your behalf, the endpoint requires **edit** access to the agent page. A key without edit gets a \`403\`. The simplest edit-capable key inherits your own drive access, so create it without a \`--role\` (a plain \`--role member\` key is view-only on an agent page and will 403).

## Streaming only

Responses always stream. Set \`stream: true\`; an explicit \`stream: false\` is rejected with a \`400\` (omitting it streams anyway). This keeps a chat UI responsive and matches how the in-app agent renders.

## Store and resume conversations

Each call is stateless by default: you send the messages, the agent replies, nothing is kept. Pass a \`conversation_id\` and the thread becomes **durable** — every message is stored in PageSpace, appears on the AI Chat page in the app, and can be read back later to resume.

This holds even when your app owns the conversation UX. Set \`client_manages_history: true\` and your harness keeps its own context window — it resends the history it wants on each call — while PageSpace still records the thread under the \`conversation_id\` you pass. So you handle conversations in your harness *and* they live in PageSpace, resumable by any client (or a human in the app) that can reach them.

With \`client_manages_history\` set, you don't even have to pre-create the thread: pass a fresh \`conversation_id\` and PageSpace creates it on first use, owned by your key. (On the default path, an unknown \`conversation_id\` returns 404 — create it first with \`POST /api/v1/conversations\`.)

\`\`\`bash
# Optional: create a thread up front (drive-scoped, titled) — or just pass a new
# conversation_id on the completions call and let PageSpace adopt it.
curl https://pagespace.ai/api/v1/conversations \\
  -H "Authorization: Bearer mcp_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{ "drive_id": "<driveId>", "title": "Support bot" }'
# -> { "id": "<conversationId>", "drive_id": "<driveId>", "title": "Support bot", ... }

# Resume later: read the stored messages back to rehydrate your UI.
curl https://pagespace.ai/api/v1/conversations/<conversationId> \\
  -H "Authorization: Bearer mcp_your_key_here"
# -> { "id": "<conversationId>", ..., "messages": [ { "role": "...", "content": "..." }, ... ] }
\`\`\`

Pass \`conversation_id\` alongside \`messages\` on each \`chat/completions\` call to append to it. The conversations API is: \`POST /api/v1/conversations\` (create), \`GET /api/v1/conversations?drive_id=<driveId>\` (list), \`GET /api/v1/conversations/<id>\` (read messages), \`DELETE /api/v1/conversations/<id>\` (remove). A key can only touch conversations it owns.

## Listing agents

\`\`\`bash
curl https://pagespace.ai/api/v1/models \\
  -H "Authorization: Bearer mcp_your_key_here"
\`\`\`

Returns every AI Chat page the key can reach, each as \`{ "id": "ps-agent://<pageId>", "object": "model", "owned_by": "pagespace" }\` — drop an id straight into \`model\`.

## Build a chat app on it

This endpoint is meant to be the backend for your own chat UI: your server holds the \`mcp_\` key, calls the agent, and streams tokens to the browser — no model keys, no prompt plumbing, no tool wiring of your own. Full walkthrough: **[Build a chat app with PageSpace as the backend](/blog/build-a-chat-app-on-pagespace)**.

## Next steps

- **[PageSpace CLI](/docs/features/cli)** — mint and scope the key this API uses
- **[PageSpace SDK](/docs/features/sdk)** — the typed client for the rest of the API
- **[MCP Integration](/docs/integrations/mcp)** — connect Claude Desktop, Claude Code, or Cursor
`;

export default function AgentApiPage() {
  return <DocsMarkdown content={content} />;
}
