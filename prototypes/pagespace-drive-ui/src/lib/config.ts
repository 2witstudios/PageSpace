/*
 * Demo configuration. Everything comes from Vite env vars (a `.env.local`),
 * with a settings panel to override the token/drive at runtime. Mint the
 * tokens from the CLI: `pagespace keys create --drive <id> --name demo
 * --show-token` (an inherit key — the chat endpoint needs edit access, so a
 * plain `--role member` key would 403).
 */

const env = import.meta.env;

export const config = {
  // In dev, hit the same origin so Vite's proxy forwards /api to pagespace.ai
  // (the API sends no CORS headers). In prod, the deployed origin/api URL.
  apiUrl: (env.VITE_PAGESPACE_API_URL as string | undefined) ?? (env.DEV ? window.location.origin : "https://pagespace.ai"),
  token: (env.VITE_PAGESPACE_TOKEN as string | undefined) ?? "",
  driveId: (env.VITE_PAGESPACE_DRIVE_ID as string | undefined) ?? "",
  agentId: (env.VITE_PAGESPACE_AGENT_ID as string | undefined) ?? "",
  botName: (env.VITE_PAGESPACE_BOT_NAME as string | undefined) ?? "Support",
};

export type ViewMode = "ask" | "docs" | "manage";
