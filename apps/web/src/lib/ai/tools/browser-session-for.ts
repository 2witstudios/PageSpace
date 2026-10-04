/**
 * The browser session an agent's tool call operates, and WHO it is billed to (WAL-2, review #2760
 * P1; pinned by review 5407898542 P2-1): the session is keyed to the conversation's owner and
 * agent, but its compute is recorded under and capped against `actorId` — the person whose turn
 * this is (`ctx.userId`) — never the session owner.
 */
import { deriveBrowserSessionId } from '@pagespace/browser-worker/derive-browser-session-id';
import type { SandboxActorContext } from '@pagespace/lib/services/sandbox/tool-runners';
import type { BrowserBilling } from './browser-metering-adapter';

export function browserSessionFor(ctx: Pick<SandboxActorContext, 'userId' | 'tenantId' | 'driveId' | 'ownerId' | 'conversationId' | 'agentPageId'>): { sessionId: string; agentId: string; billing: BrowserBilling } {
  const ownerId = ctx.ownerId ?? ctx.userId;
  const agentId = ctx.agentPageId ?? `global:${ctx.userId}`;
  const sessionId = deriveBrowserSessionId({ tenantId: ctx.tenantId, ownerId, agentId, conversationId: ctx.conversationId });
  return {
    sessionId,
    agentId,
    billing: { driveId: ctx.driveId ?? null, ownerId, actorId: ctx.userId, agentPageId: ctx.agentPageId ?? null, conversationId: ctx.conversationId },
  };
}
