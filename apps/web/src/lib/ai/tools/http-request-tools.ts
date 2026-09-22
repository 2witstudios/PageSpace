/**
 * `http_request` — an agent calls an external HTTPS API with one of its
 * ACCOUNTS (L2·G2; epic invariant 1, reference never value).
 *
 * The model names an account by id and describes the request. It never sees,
 * sends or receives the credential: the account authority decides whether this
 * caller may use this account for this exact request (`authorize`), signs a
 * one-use grant, and the separate credential plane attaches the key, sends the
 * request to the pinned origin only, and hands back a filtered view. The tool
 * result carries the account id and that view — nothing about the account and
 * never a value (`toHttpRequestToolResult`).
 *
 * Unknown generic requests need a person's approval of the exact request (or a
 * standing permission the person chose for that account); the result says so
 * and carries what the approval card renders. Offered only when the deployment
 * has configured the credential plane (`filterToolsForAgentAccounts`).
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { AgentPageId, ConversationId, RunId, SessionId, UserId } from '@pagespace/lib/agent-accounts/grant';
import { toHttpRequestToolResult } from '@pagespace/lib/agent-accounts/to-http-request-tool-result';
import { getAccountAuthority } from '@/lib/agent-accounts/account-authority-client';
import type { ToolExecutionContext } from '../core/types';

const MAX_BODY_CHARS = 1_000_000;
/** What a generic request carries (no provider registry entries yet): anything else is dropped before digesting. */
const PROJECTED_HEADERS = new Set(['accept', 'content-type', 'content-length']);

/** An origin as a person reads it: the default port is implied. */
const siteOf = (origin: string) => origin.replace(/:443$/, '');

export const httpRequestTools = {
  list_accounts: tool({
    description: `List the accounts you can use with http_request: each account's id, name and the sites it works with. Never returns a key. Use it to find the accountId for a site the person mentioned.`,
    inputSchema: z.object({}),
    execute: async (_input, { experimental_context }) => {
      const context = experimental_context as ToolExecutionContext | undefined;
      const authority = getAccountAuthority();
      if (context?.userId === undefined || authority === null) return { accounts: [] };
      const agentPageId = context.chatSource?.type === 'page' ? (context.chatSource.agentPageId ?? null) : null;
      // The same scoping as the settings list: an agent page's own accounts, or the person's own for the global assistant.
      const listed = await authority.listAccounts({
        actorUserId: context.userId as UserId,
        owner: agentPageId === null ? { kind: 'user' } : { kind: 'agent_page', agentPageId },
        // A drive-scoped credential never sees accounts outside its drives (second review MED-2).
        allowedDriveIds: context.mcpAllowedDriveIds ?? [],
      });
      return {
        accounts: (listed ?? []).filter((account) => account.status === 'active').map((account) => ({ accountId: account.id, name: account.name, sites: account.allowedOrigins.map(siteOf), ready: account.ready })),
      };
    },
  }),

  http_request: tool({
    description: `Make an HTTPS request to an external API using one of this agent's accounts (added by a person in the agent's Accounts settings, or in their personal settings for the global assistant). Pass the account id (list_accounts shows them), never a key: the account supplies its own credential, so do not set Authorization, Cookie or Host. Only the account's allowed origins can be reached, redirects are not followed, and credential-like values are removed from what comes back. Requests may need a person's approval first; if the result says approval_required, ask the person to approve it, then repeat the identical request.`,
    inputSchema: z.object({
      accountId: z.string().min(1).max(64).describe('The id of the account to use, as listed in the agent settings.'),
      method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
      url: z.string().min(1).max(4_096).describe('The full https:// URL on one of the account’s allowed origins.'),
      headers: z.record(z.string(), z.string()).optional().describe('Extra request headers such as accept or content-type. Never credentials.'),
      body: z.string().max(MAX_BODY_CHARS).optional().describe('The request body as text (for example JSON).'),
    }),
    execute: async ({ accountId, method, url, headers, body }, { experimental_context }) => {
      const context = experimental_context as ToolExecutionContext | undefined;
      const authority = getAccountAuthority();
      if (context?.userId === undefined || authority === null) {
        return toHttpRequestToolResult({ accountId, result: { ok: false, reason: 'account_unavailable' } });
      }
      context.turnId ??= crypto.randomUUID();
      const agentPageId = context.chatSource?.type === 'page' ? (context.chatSource.agentPageId ?? null) : null;
      const result = await authority.requestOperation({
        caller: {
          actorUserId: context.userId as UserId,
          actingHumanUserId: context.userId as UserId,
          // A live session only when a person is driving this run; an agent-to-agent or scheduled run is unattended.
          sessionId: context.requestOrigin === 'agent' ? null : ((context.authSessionId ?? null) as SessionId | null),
          agentPageId: agentPageId as AgentPageId | null,
          conversationId: (context.conversationId ?? `conversation-${context.turnId}`) as ConversationId,
          runId: context.turnId as RunId,
          callerCeiling: { allowedDriveIds: context.mcpAllowedDriveIds ?? [], originatingMcpTokenId: context.mcpTokenId ?? null },
        },
        accountId,
        request: { channel: 'http-executor', method, url, headers: headers ?? {}, body: new TextEncoder().encode(body ?? '') },
      });
      const droppedHeaders = Object.keys(headers ?? {}).filter((name) => !PROJECTED_HEADERS.has(name.trim().toLowerCase()));
      return toHttpRequestToolResult({ accountId, result, droppedHeaders });
    },
  }),
};
