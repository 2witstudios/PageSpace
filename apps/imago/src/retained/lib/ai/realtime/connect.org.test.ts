import { describe, expect, it, vi } from 'vitest';
import {
  connectVoiceCall,
  type VoiceConnectDeps,
} from './connect';
import type { VoiceTarget } from './voice-target';
import {
  CALL_OK,
  FakePeerConnection,
  asPeer,
  asStream,
  fakeCreateMediaStream,
  fakeStream,
  respondWith,
} from './__tests__/webrtc-fakes';

const TARGET: VoiceTarget = { conversationId: 'conv-1', type: 'global' };

type Harness = {
  readonly peer: FakePeerConnection;
  readonly microphone: ReturnType<typeof fakeStream>;
  readonly fetchImpl: ReturnType<typeof vi.fn>;
  readonly events: unknown[];
  readonly remoteStreams: MediaStream[];
  readonly lost: ReturnType<typeof vi.fn>;
  readonly deps: VoiceConnectDeps;
};

const harness = (
  overrides: Partial<VoiceConnectDeps> = {},
  response: Response = respondWith({ body: CALL_OK }),
): Harness => {
  const peer = new FakePeerConnection();
  const microphone = fakeStream('mic-1');
  const events: unknown[] = [];
  const remoteStreams: MediaStream[] = [];
  const lost = vi.fn();
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);

  const deps: VoiceConnectDeps = {
    target: TARGET,
    onEvent: (event) => events.push(event),
    onRemoteTrack: (stream) => remoteStreams.push(stream),
    onConnectionLost: lost,
    fetchImpl: fetchImpl as unknown as VoiceConnectDeps['fetchImpl'],
    createPeerConnection: () => asPeer(peer),
    getUserMedia: async () => asStream(microphone),
    createMediaStream: fakeCreateMediaStream,
    ...overrides,
  };

  return { peer, microphone, fetchImpl, events, remoteStreams, lost, deps };
};

describe('organization-aware voice admission', () => {
  it('SPEND-1 (partial) a fresh agent thread names its actual page so the server resolves its drive', async () => {
    const h = harness({ target: { conversationId: 'fresh-thread', type: 'page', agentPageId: 'agent-page' } });
    const result = await connectVoiceCall(h.deps);
    expect(result.ok).toBe(true);
    expect(JSON.parse(h.fetchImpl.mock.calls[0][1].body as string)).toMatchObject({ conversationId: 'fresh-thread', agentPageId: 'agent-page' });
    if (result.ok) result.connection.stop();
  });

  it('SPEND-4 (partial) POL-8 (partial) returns the actual fallback and withheld-history notices for the call chrome to disclose', async () => {
    const fallback = { from: 'drive_wallet', to: 'own_credits', walletId: 'personal-wallet' };
    const h = harness({}, respondWith({ body: { ...CALL_OK, spendFallback: fallback, historyWithheld: 'Organization policy withheld earlier messages.' } }));
    const result = await connectVoiceCall(h.deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection).toMatchObject({ spendFallback: fallback, historyWithheld: 'Organization policy withheld earlier messages.' });
    result.connection.stop();
  });

  it('ignores malformed fallback and withheld-history response fields', async () => {
    const h = harness({}, respondWith({ body: { ...CALL_OK, spendFallback: { from: 'other-account', to: 'own_credits' }, historyWithheld: 42 } }));
    const result = await connectVoiceCall(h.deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection).toMatchObject({ spendFallback: null, historyWithheld: null });
    result.connection.stop();
  });
});
