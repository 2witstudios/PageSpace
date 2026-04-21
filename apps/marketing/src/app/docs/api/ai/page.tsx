import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "AI API",
  description: "PageSpace AI API: chat streaming, provider settings, global conversations, page agents, abort, and local-model discovery.",
  path: "/docs/api/ai",
  keywords: ["API", "AI", "chat", "streaming", "providers", "agents", "conversations"],
});

const content = `
# AI API

Chat streaming, provider settings, global conversations, and page-agent management. Chat streaming follows the [Vercel AI SDK v5](https://sdk.vercel.ai/) protocol — send an array of \`UIMessage\` objects and consume a UI-message stream response.

## Chat on a page

### POST /api/ai/chat

Stream an AI response on an AI-chat page. Uses the AI SDK v5 shape.

**Body:**
\`\`\`json
{
  "messages": [{ "role": "user", "parts": [{ "type": "text", "text": "..." }] }],
  "chatId": "string",
  "conversationId": "string",
  "selectedProvider": "string",
  "selectedModel": "string",
  "openRouterApiKey": "string",
  "googleApiKey": "string",
  "openAIApiKey": "string",
  "anthropicApiKey": "string",
  "xaiApiKey": "string",
  "ollamaBaseUrl": "string",
  "glmApiKey": "string",
  "mcpTools": [],
  "isReadOnly": false,
  "webSearchEnabled": false,
  "pageContext": {
    "pageId": "string",
    "pageTitle": "string",
    "pageType": "string",
    "pagePath": "string",
    "parentPath": "string",
    "breadcrumbs": ["string"],
    "driveId": "string",
    "driveName": "string",
    "driveSlug": "string"
  }
}
\`\`\`

Only \`messages\` is strictly required; everything else is optional. \`chatId\` is the page ID for the AI-chat page. Server-side conversation history is loaded from the database — the \`messages\` array is used only to extract the latest user turn. Request body is capped at 25MB.

**Response:** a UI-message stream (Server-Sent Events) containing text chunks, tool calls, and tool results.

**Auth:** Edit permission on the page.

---

### GET /api/ai/chat

Return the current user's provider configuration status (which providers have keys configured).

---

### PATCH /api/ai/chat

Update the provider/model selection for a specific AI-chat page.

---

### GET /api/ai/chat/messages?pageId=...

Load persisted chat messages for a page in chronological order, including tool calls and results.

**Auth:** View permission on the page.

---

### PATCH /api/ai/chat/messages/[messageId]

Edit a persisted message (currently limited to the last user message).

---

### DELETE /api/ai/chat/messages/[messageId]

Delete a persisted message.

---

### GET /api/ai/chat/messages/[messageId]/undo

Preview the undo state produced by an assistant message's tool calls.

---

### POST /api/ai/chat/messages/[messageId]/undo

Apply the undo — revert page edits caused by that assistant turn.

---

### POST /api/ai/abort

Signal the server to stop a streaming response for the current user/conversation.

## Provider settings

### GET /api/ai/settings

Return the current provider/model selection, subscription tier, and per-provider configuration status (which have API keys or base URLs set).

---

### POST /api/ai/settings

Save credentials for a provider.

**Body:**
\`\`\`json
{
  "provider": "openrouter | google | openai | anthropic | xai | ollama | lmstudio | glm | minimax | azure_openai",
  "apiKey": "string",
  "baseUrl": "string"
}
\`\`\`

\`apiKey\` is required for remote providers; \`baseUrl\` is required for \`ollama\`, \`lmstudio\`, and \`azure_openai\` and is validated for SSRF. API keys are encrypted before storage.

---

### PATCH /api/ai/settings

Update the active provider and model selection.

**Body:**
\`\`\`json
{ "provider": "string", "model": "string" }
\`\`\`

\`provider\` accepts the configurable providers plus the virtual \`pagespace\` and \`openrouter_free\` IDs. \`model\` may be empty for local providers (Ollama, LM Studio, Azure OpenAI) whose models are discovered dynamically. Pro-tier models on \`pagespace\` require an active Pro or Business subscription.

---

### DELETE /api/ai/settings

Remove stored credentials for a provider.

**Body:**
\`\`\`json
{ "provider": "string" }
\`\`\`

Returns \`204 No Content\`.

## Local model discovery

### GET /api/ai/ollama/models

List models available on the user's Ollama base URL.

---

### GET /api/ai/lmstudio/models

List models available on the user's LM Studio base URL.

## Global conversations

"Global" conversations are cross-drive AI sessions not bound to a page.

| Route | Method | Purpose |
|---|---|---|
| \`/api/ai/global\` | GET | List the user's global conversations |
| \`/api/ai/global\` | POST | Create a new global conversation |
| \`/api/ai/global/active\` | GET | Return the most recently active conversation |
| \`/api/ai/global/[id]\` | GET | Fetch a conversation |
| \`/api/ai/global/[id]\` | PATCH | Update conversation metadata (e.g. title) |
| \`/api/ai/global/[id]\` | DELETE | Delete the conversation |
| \`/api/ai/global/[id]/messages\` | GET | List messages in a conversation |
| \`/api/ai/global/[id]/messages\` | POST | Send a message (streams AI response) |
| \`/api/ai/global/[id]/messages/[messageId]\` | PATCH | Edit a message |
| \`/api/ai/global/[id]/messages/[messageId]\` | DELETE | Delete a message |
| \`/api/ai/global/[id]/usage\` | GET | Per-conversation AI usage statistics |

## Page agents

Page agents are first-class AI agents backed by an \`AI_CHAT\` page with a saved system prompt, tool allowlist, provider, and model. They can be invoked directly and also consulted by other agents (agent-to-agent).

### POST /api/ai/page-agents/create

Create a new page agent.

---

### PUT /api/ai/page-agents/[agentId]/config

Replace the agent configuration.

**Body:**
\`\`\`json
{
  "systemPrompt": "string",
  "enabledTools": ["string"],
  "aiProvider": "string",
  "aiModel": "string",
  "agentDefinition": {},
  "visibleToGlobalAssistant": true,
  "expectedRevision": 0
}
\`\`\`

\`expectedRevision\` enables optimistic concurrency — the server rejects the update with a revision mismatch if another writer has moved past that revision.

---

### GET /api/ai/page-agents/[agentId]/conversations

List conversations this agent has participated in.

---

### POST /api/ai/page-agents/[agentId]/conversations

Start a new conversation with the agent.

---

### PATCH /api/ai/page-agents/[agentId]/conversations/[conversationId]

Update conversation metadata.

---

### DELETE /api/ai/page-agents/[agentId]/conversations/[conversationId]

Delete a conversation.

---

### GET /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages

List messages in a page-agent conversation.

---

### PATCH /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages/[messageId]

Edit a message.

---

### DELETE /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages/[messageId]

Delete a message.

---

### POST /api/ai/page-agents/consult

Agent-to-agent communication. Ask a page agent a question and receive a single-turn response.

**Body:**
\`\`\`json
{
  "agentId": "string",
  "question": "string",
  "context": "string"
}
\`\`\`

---

### GET /api/ai/page-agents/multi-drive

List page agents visible to the caller across multiple drives.
`;

export default function AiApiPage() {
  return <DocsMarkdown content={content} />;
}
