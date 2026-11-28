/**
 * `/llms.txt` — the first document an AI agent looks for on a site
 * (https://llmstxt.org). It says what PageSpace is and, when this deployment's
 * agent door is open, that an agent may create a PageSpace account of its own
 * with no email and no human, and where the recipe (`/auth.md`) is.
 *
 * Pure: built only from the configured issuer and whether the door is open,
 * never from a request (same rule as `/auth.md`, threat model T14).
 */

import { buildServerMetadata } from '@pagespace/lib/auth/oauth/metadata';

export interface LlmsTxtConfig {
  /** Canonical deployment origin, e.g. `https://pagespace.ai`. Trailing slash tolerated. */
  issuer: string;
  /** Whether agent self-signup is enabled on this deployment (`isAgentDoorOpen`). */
  agentSignupOpen: boolean;
}

export function buildLlmsTxt(config: LlmsTxtConfig): string {
  const metadata = buildServerMetadata({ issuer: config.issuer });
  const { issuer } = metadata;

  const intro = `# PageSpace

> PageSpace is an AI-native workspace: drives of pages (documents, task lists, sheets, canvases, files, channels and AI agents) that people and AI agents work in together, with an HTTP API, a CLI (\`pagespace\`) and an MCP server.
`;

  const forAgents = config.agentSignupOpen
    ? `
## For AI agents: create your own account

You (an AI agent — Claude Code, Cursor, Codex, a ChatGPT agent, a browser agent) can create a PageSpace account of your own to try PageSpace out: no email address and no human needed. Your account is a real PageSpace user — drives, pages, tasks, API keys, the CLI and MCP all work. It starts with no AI credits; a human can claim you later and pay for your AI usage.

- [Agent signup recipe](${metadata.agent_auth.skill}): the whole protocol (proof-of-work challenge, register, exchange the secret for tokens, mint an API key, get claimed). Read this first.
- [Server metadata](${issuer}/.well-known/oauth-authorization-server): RFC 8414 JSON; the \`agent_auth\` block lists every endpoint.
- [Browser signup](${issuer}/auth/agent?mode=signup): for agents that drive a browser.
- CLI: \`npm i -g @pagespace/cli && pagespace signup --agent --name "<your name>"\` (no install: \`npx -y -p @pagespace/cli pagespace signup --agent --name "<your name>"\`). It stores your credential and an API key; then \`pagespace whoami\`, \`pagespace drives list\`, \`pagespace mcp\` work with no further setup.
`
    : '';

  const humans = `
## For people

- [Sign up](${issuer}/auth/signup)
- [Sign in](${issuer}/auth/signin)
- [Documentation](${issuer}/docs)
- [MCP and CLI integration](${issuer}/docs/integrations/mcp)
`;

  return intro + forAgents + humans;
}
