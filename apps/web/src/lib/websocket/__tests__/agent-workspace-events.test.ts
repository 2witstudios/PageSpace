// @vitest-environment node
/**
 * WHICH ROOMS a node broadcast reaches, and what rides on it.
 *
 * This is the fanout itself — the one thing the write funnel's own suite cannot
 * see, because it mocks this module wholesale. Two rooms and exactly two:
 *
 *  - `session:<id>`, joined only while a workspace's grid is mounted;
 *  - `user:<ownerId>:sessions`, the owner's directory plane, joined
 *    automatically at connect. This is the one that closes the epic's headline
 *    symptom — a pane an agent places in a workspace nobody is looking at used
 *    to reach nobody, so the sidebar learned about it from the 120s poll.
 *
 * The prohibition is asserted, not merely written down: a `drive:<id>` room
 * would be a workspace-ENUMERATION oracle, because `decideAgentSessionAccess`
 * admits any drive member while `listSessions` filters on `ownerId`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: () => ({ 'x-signature': 'signed' }),
}));
vi.mock('@pagespace/lib/logging/logger-browser', () => ({
  browserLoggers: { realtime: { child: () => ({ warn: vi.fn(), error: vi.fn() }) } },
}));
vi.mock('@/lib/logging/mask', () => ({ maskIdentifier: (value: string) => value }));

const { broadcastWorkspaceNodesUpdated } = await import('../agent-workspace-events');

const NODES = [{ nodeType: 'root' as const, id: 'ws-1', parentId: null, position: 0 as const, axis: 'row' as const }];

/** Every `{channelId, event, payload}` this call put on the wire. */
function emitted(): Array<{ channelId: string; event: string; payload: Record<string, unknown> }> {
  return mockFetch.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', mockFetch);
  process.env.INTERNAL_REALTIME_URL = 'http://realtime.internal';
});

describe('broadcastWorkspaceNodesUpdated', () => {
  it('reaches the workspace room AND the owner\'s own sessions room', () => {
    broadcastWorkspaceNodesUpdated({ workspaceId: 'ws-1', rev: 4, nodes: NODES, ownerId: 'user-1' });

    expect(emitted().map((message) => message.channelId).sort()).toEqual([
      'session:ws-1',
      'user:user-1:sessions',
    ]);
    for (const message of emitted()) {
      expect(message.event).toBe('workspace:nodes-updated');
    }
  });

  it('sends the IDENTICAL structural payload to both, with the routing field stripped', () => {
    broadcastWorkspaceNodesUpdated({ workspaceId: 'ws-1', rev: 4, nodes: NODES, ownerId: 'user-1' });

    const payloads = emitted().map((message) => message.payload);
    expect(payloads[0]).toEqual({ workspaceId: 'ws-1', rev: 4, nodes: NODES });
    expect(payloads[1]).toEqual(payloads[0]);
    // `ownerId` is routing, not content: a subscriber has no business learning
    // who owns a workspace from a layout event.
    for (const payload of payloads) expect(payload).not.toHaveProperty('ownerId');
  });

  /**
   * DO NOT GENERALISE THIS. A `drive:<driveId>` room would hand every member of
   * the drive a rev-bumping event per workspace id — an enumeration oracle over
   * workspaces `listSessions` deliberately never shows them.
   */
  it('reaches no other room — never the drive', () => {
    broadcastWorkspaceNodesUpdated({ workspaceId: 'ws-1', rev: 4, nodes: NODES, ownerId: 'user-1' });
    expect(emitted()).toHaveLength(2);
    expect(emitted().every((message) => !message.channelId.startsWith('drive:'))).toBe(true);
  });

  it('still reaches the workspace room when the owner could not be read', () => {
    // Fails CLOSED: an owner that could not be resolved means the event does
    // not reach the owner's plane, never that it reaches somebody else's.
    broadcastWorkspaceNodesUpdated({ workspaceId: 'ws-1', rev: 4, nodes: NODES, ownerId: null });
    expect(emitted().map((message) => message.channelId)).toEqual(['session:ws-1']);
  });

  it('omits the owner room entirely when no owner is supplied at all', () => {
    broadcastWorkspaceNodesUpdated({ workspaceId: 'ws-1', rev: 4, nodes: NODES });
    expect(emitted().map((message) => message.channelId)).toEqual(['session:ws-1']);
  });

  it('carries no titles — the payload is structural, because a room has no viewer to redact for', () => {
    broadcastWorkspaceNodesUpdated({
      workspaceId: 'ws-1',
      rev: 4,
      nodes: [
        ...NODES,
        { nodeType: 'pane', id: 'n1', parentId: 'ws-1', position: 0, target: { kind: 'chat', id: 'conv-1' } },
      ],
      ownerId: 'user-1',
    });
    for (const message of emitted()) {
      expect(JSON.stringify(message.payload)).not.toMatch(/title/i);
    }
  });

  it('skips the broadcast entirely when no realtime URL is configured, rather than throwing', () => {
    delete process.env.INTERNAL_REALTIME_URL;
    expect(() =>
      broadcastWorkspaceNodesUpdated({ workspaceId: 'ws-1', rev: 4, nodes: NODES, ownerId: 'user-1' }),
    ).not.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
