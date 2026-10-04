import { describe, it, expect } from 'vitest';
import { browserSessionFor } from '../browser-session-for';

describe('browserSessionFor — the browser session a tool call operates, and who it is billed to', () => {
  it('WAL-2 (partial) review #2760 P2-1: Ben driving Priya\'s agent bills the browser to BEN (the actor), on the session keyed to Priya', () => {
    const asPriya = browserSessionFor({ userId: 'priya', tenantId: 't1', driveId: 'drive-1', ownerId: 'priya', conversationId: 'conv-1', agentPageId: 'agent-1' });
    const asBen = browserSessionFor({ userId: 'ben', tenantId: 't1', driveId: 'drive-1', ownerId: 'priya', conversationId: 'conv-1', agentPageId: 'agent-1' });

    expect(asBen.billing).toEqual({ driveId: 'drive-1', ownerId: 'priya', actorId: 'ben', agentPageId: 'agent-1', conversationId: 'conv-1' });
    // One shared session — the conversation's — whoever is acting in it.
    expect(asBen.sessionId).toBe(asPriya.sessionId);
    expect(asBen.agentId).toBe('agent-1');
  });

  it('a global (driveless) context is the acting user\'s own session and bill', () => {
    const own = browserSessionFor({ userId: 'ben', tenantId: 't1', conversationId: 'conv-2' });
    expect(own.billing).toEqual({ driveId: null, ownerId: 'ben', actorId: 'ben', agentPageId: null, conversationId: 'conv-2' });
    expect(own.agentId).toBe('global:ben');
  });
});
