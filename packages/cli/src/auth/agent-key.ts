/**
 * An AI agent minting its own `mcp_` access key (ADR 0008 Decision 6, §5
 * assertion 25). An agent's account token carries `account offline_access`
 * and no content access; content — the CLI's drive/page verbs and
 * `pagespace mcp` — always rides a key. A human mints keys through a browser
 * consent screen (`pagespace keys create`); an agent has no browser and no
 * human, and `POST /api/auth/mcp-tokens` accepts exactly one bearer for that
 * reason: the agent's own `account`-scoped access token from its jwt-bearer
 * grant. The key acts as the agent in every drive the agent can reach, and in
 * no drive it cannot.
 *
 * A CLI-local operation rather than an SDK one: the SDK deliberately exposes
 * no key-minting operation (see its `operations/mcp-tokens.ts`). Lives in
 * `auth/`, not `commands/`, because it builds its own client around a token
 * the command just obtained — the same sanctioned shape as `confirm-identity.ts`.
 */
import { z } from 'zod';
import { defineOperation, PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';

/** The stored-key name `signup --agent` / `login --agent` keep the agent's own key under, and activate. */
export const AGENT_CONTENT_KEY_NAME = 'agent';

/** The server-side key name: what the agent (and later its owner) sees in key lists. */
export const AGENT_CONTENT_KEY_LABEL = 'pagespace-cli (agent)';

/** What the stored static credential records as the key's grant: every drive the agent can reach. */
export const AGENT_CONTENT_KEY_SCOPES: readonly string[] = ['all_drives'];

export const mintAgentKeyOperation = defineOperation({
  name: 'agent.mintKey',
  method: 'POST',
  path: '/api/auth/mcp-tokens',
  inputSchema: z.strictObject({ name: z.string().min(1).max(100) }),
  outputSchema: z.object({ id: z.string().min(1), name: z.string(), token: z.string().startsWith('mcp_') }),
  requiredScope: 'account',
  description: "Mint an mcp_ key for the calling agent, acting as the agent in every drive it can reach.",
});

export interface MintedAgentKey {
  readonly id: string;
  readonly token: string;
}

export type MintAgentKey = (params: { host: string; accessToken: string; name?: string }) => Promise<MintedAgentKey>;

export const mintAgentKey: MintAgentKey = async ({ host, accessToken, name }) => {
  const client = new PageSpaceClient({
    baseUrl: host,
    auth: new StaticTokenProvider(accessToken),
    // A POST is never retried by the facade; this only bounds the one call.
    timeoutMs: 15_000,
  });
  const minted = await client.invoke(mintAgentKeyOperation, { name: name ?? AGENT_CONTENT_KEY_LABEL });
  return { id: minted.id, token: minted.token };
};
