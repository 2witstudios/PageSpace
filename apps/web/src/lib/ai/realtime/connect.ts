/**
 * The browser half of a live voice call: microphone in, model's voice out,
 * event stream on a data channel — and NOT ONE LINE of OpenAI credential
 * handling.
 *
 * The page opens a peer connection, adds the mic track, opens the `oai-events`
 * data channel, and POSTs its SDP offer to OUR route
 * (`POST /api/voice/realtime/call`), which relays it to OpenAI and answers with
 * the answer SDP. `api.openai.com` is never contacted from here, no ephemeral
 * secret ever reaches the page, and the tool schemas are not sent to the client
 * at all — they ride a signed server-to-server hop the browser cannot see.
 *
 * WHY THE MICROPHONE IS ASKED FOR FIRST, which is the reverse of the prototype's
 * order. The prototype asked its server for a secret before touching the mic, so
 * a misconfigured deployment could not trigger a permission prompt for nothing.
 * With a relay route that is not available: the route's input IS the SDP offer,
 * and an offer cannot exist before there is a track to offer. The trade is a
 * prompt that can be followed by a 503 — and the far larger prize is that the
 * page holds no credential.
 *
 * Isolated from React on purpose. Every effect is a parameter, so the whole
 * handshake runs against fakes with no live network and no real microphone.
 */

import { REALTIME_DATA_CHANNEL } from './session';
import type { VoiceTarget } from './voice-target';
import { parseEvent } from '@pagespace/lib/realtime/voice-events';
import type { VoiceLocationContext } from '@pagespace/lib/realtime/voice-bridge-contract';
import {
  classifyMicFailure,
  getMicPermissionErrorMessage,
  type MicFailure,
} from '@/lib/voice/mic-errors';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

/** Our own route. The OpenAI endpoints are the server's business, not ours. */
export const VOICE_CALL_ROUTE = '/api/voice/realtime/call';

/**
 * What the route can refuse us with, as distinct from what the microphone can.
 * Kept separate from the `mic-*` cases below because these five all carry a
 * sentence the SERVER wrote — the upgrade prompt, the unconfigured deployment —
 * and ours are only the fallback for when it did not.
 */
export type RouteFailure =
  /** Signed out — the route refused before it ever looked at the offer. */
  | 'unauthorized'
  /** Authenticated, but the plan does not include voice. */
  | 'not-entitled'
  /** This deployment has no managed voice key configured. */
  | 'unavailable'
  /** Our server reached OpenAI and OpenAI refused the call. */
  | 'call-rejected'
  /** The handshake broke on our side of the wire: SDP, transport, or route. */
  | 'signaling-failed';

/**
 * Every distinct thing that can go wrong, named. The five `mic-*` cases are
 * generated from `MicFailure` rather than restated, so the two lists cannot
 * drift: a denied prompt and an absent device are different outcomes needing
 * opposite advice, and flattening them into one "voice failed" is what makes a
 * user try the wrong fix.
 */
export type VoiceConnectFailure = `mic-${MicFailure}` | RouteFailure;

export type VoiceConnection = {
  /** The `rtc_…` id. Not the session (`sess_…`) and not a function call (`call_…`). */
  readonly callId: string;
  /**
   * Whether the realtime server took the call. `false` is a WORKING audio call
   * with no tools, no transcript persistence and no metering — the server
   * reports that honestly rather than implying full capability, so the UI can.
   */
  readonly attached: boolean;
  /** The server-enforced ceiling on this call, for chaining ahead of it. */
  readonly maxDurationMs: number | undefined;
  /** The stream this connection OWNS. Stopped by `stop`, and only by `stop`. */
  readonly microphone: MediaStream;
  /** Silence or unsilence the mic without renegotiating or dropping the call. */
  readonly setMicrophoneEnabled: (enabled: boolean) => void;
  readonly stop: () => void;
};

export type VoiceConnectFailed = {
  readonly ok: false;
  readonly reason: VoiceConnectFailure;
  /** One sentence, for a human. */
  readonly message: string;
  /** Which step broke, for whoever has to debug it. */
  readonly detail: string;
};

export type VoiceConnectResult =
  | { readonly ok: true; readonly connection: VoiceConnection }
  | VoiceConnectFailed;

export type VoiceConnectDeps = {
  /** The conversation this call speaks into. */
  readonly target: VoiceTarget;
  /** Where the user is standing, for the tools. A default, never an authorization. */
  readonly locationContext?: VoiceLocationContext;
  readonly timezone?: string;
  /**
   * An already-granted microphone to reuse. Its tracks are CLONED, never
   * adopted: a chained call must keep working after the call it replaced stops
   * its own tracks, and a clone is independent of the original while sharing
   * the same device — so the user is prompted once and the recording indicator
   * never blinks between calls.
   */
  readonly microphone?: MediaStream;
  /**
   * Whether the mic is live from the moment the call connects. A chained call
   * starts silent so two sessions cannot both hear the same sentence during the
   * moment they overlap.
   */
  readonly microphoneEnabled?: boolean;
  readonly onEvent: (event: unknown) => void;
  readonly onRemoteTrack: (stream: MediaStream) => void;
  /** The connection left a usable state on its own. Never fired by `stop`. */
  readonly onConnectionLost: () => void;

  // Seams. Defaults are the real thing; tests hand in fakes.
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly createPeerConnection?: () => RTCPeerConnection;
  readonly getUserMedia?: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
  /** Only reached when reusing a microphone; jsdom has no `MediaStream`. */
  readonly createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream;
};

const ROUTE_MESSAGES: Record<RouteFailure, string> = {
  unauthorized: 'Your session expired. Sign in again to start a voice call.',
  'not-entitled': 'Voice calls need a Pro plan or above.',
  unavailable: 'Voice mode is not configured on this deployment.',
  'call-rejected': 'The voice service refused the call. Check the server logs.',
  'signaling-failed': 'Could not reach the voice service.',
};

export const describeThrown = (error: unknown): string =>
  error instanceof Error
    ? `${error.name}: ${error.message}`
    : `non-error thrown: ${String(error)}`;

/**
 * States a peer connection does not come back from. `disconnected` is included
 * even though ICE can sometimes recover from it: a voice call that has already
 * stopped carrying audio has failed as far as the person talking is concerned,
 * and silently waiting on a maybe-recovery is worse than saying so.
 */
const LOST_STATES = new Set<RTCPeerConnectionState>([
  'failed',
  'disconnected',
  'closed',
]);

/** Map our route's status onto a named failure. */
export const failureForStatus = (status: number): RouteFailure => {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'not-entitled';
  if (status === 503) return 'unavailable';
  if (status === 502) return 'call-rejected';
  return 'signaling-failed';
};

/**
 * Read the route's error body without letting a non-JSON one throw over the
 * real error. The route speaks `{ error, message, code, upstream, … }`;
 * `message` is the sentence written for a human, `error` the short label.
 */
const readRouteError = async (
  response: Response,
): Promise<{ message: string | undefined; detail: string }> => {
  const text = await response.text().catch(() => '');
  let message: string | undefined;
  let code: string | undefined;
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === 'object' && body !== null) {
      const record = body as Record<string, unknown>;
      const spoken = record.message ?? record.error;
      if (typeof spoken === 'string' && spoken.length > 0) message = spoken;
      if (typeof record.code === 'string') code = record.code;
    }
  } catch {
    // Not JSON. The raw text is still the best detail available.
  }
  return {
    message,
    detail: `${VOICE_CALL_ROUTE} returned ${response.status}${
      code === undefined ? '' : ` (${code})`
    }: ${text.slice(0, 300)}`,
  };
};

const failure = (
  reason: VoiceConnectFailure,
  detail: string,
  message: string,
): VoiceConnectFailed => {
  // The UI shows one speakable sentence; the console carries the cause.
  console.error(`[voice] ${reason}: ${detail}`);
  return { ok: false, reason, message, detail };
};

type MicResult =
  | { readonly ok: true; readonly stream: MediaStream }
  | VoiceConnectFailed;

/**
 * The call's own microphone: a fresh grant, or independent clones of one the
 * caller already holds.
 */
const acquireMicrophone = async (
  deps: VoiceConnectDeps,
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>,
  createMediaStream: (tracks: MediaStreamTrack[]) => MediaStream,
): Promise<MicResult> => {
  if (deps.microphone) {
    const clones = deps.microphone
      .getAudioTracks()
      .map((track) => track.clone());
    if (clones.length === 0) {
      return failure(
        'mic-unknown',
        'the microphone handed in for reuse carried no audio tracks',
        getMicPermissionErrorMessage(undefined),
      );
    }
    return { ok: true, stream: createMediaStream(clones) };
  }

  try {
    return { ok: true, stream: await getUserMedia({ audio: true }) };
  } catch (error) {
    return failure(
      `mic-${classifyMicFailure(error)}`,
      describeThrown(error),
      getMicPermissionErrorMessage(error),
    );
  }
};

export const connectVoiceCall = async (
  deps: VoiceConnectDeps,
): Promise<VoiceConnectResult> => {
  const fetchImpl = deps.fetchImpl ?? fetchWithAuth;
  const createPeerConnection =
    deps.createPeerConnection ?? (() => new RTCPeerConnection());
  const getUserMedia =
    deps.getUserMedia ??
    ((constraints: MediaStreamConstraints) =>
      navigator.mediaDevices.getUserMedia(constraints));
  const createMediaStream =
    deps.createMediaStream ?? ((tracks: MediaStreamTrack[]) => new MediaStream(tracks));

  const acquired = await acquireMicrophone(deps, getUserMedia, createMediaStream);
  if (!acquired.ok) return acquired;
  const microphone = acquired.stream;

  const setMicrophoneEnabled = (next: boolean) => {
    for (const track of microphone.getAudioTracks()) {
      track.enabled = next;
    }
  };
  setMicrophoneEnabled(deps.microphoneEnabled ?? true);

  const peer = createPeerConnection();

  /**
   * Teardown. The state handler is detached BEFORE closing, because closing
   * drives the connection to `closed` — which is in `LOST_STATES` — and a
   * deliberate hangup reported as a connection loss would show the user an
   * error for something they just did.
   */
  const stop = () => {
    peer.onconnectionstatechange = null;
    peer.ontrack = null;
    for (const track of microphone.getTracks()) {
      track.stop();
    }
    peer.close();
  };

  peer.ontrack = (event: RTCTrackEvent) => {
    const stream = event.streams[0];
    if (stream) deps.onRemoteTrack(stream);
  };
  peer.onconnectionstatechange = () => {
    if (LOST_STATES.has(peer.connectionState)) {
      deps.onConnectionLost();
    }
  };

  for (const track of microphone.getTracks()) {
    peer.addTrack(track, microphone);
  }

  const channel = peer.createDataChannel(REALTIME_DATA_CHANNEL);
  channel.onmessage = (message: MessageEvent) => {
    const event = parseEvent(message.data);
    if (event !== undefined) {
      deps.onEvent(event);
    }
  };

  // Each step is named so a failure says which one broke. "Handshake failed" is
  // what makes somebody re-debug this stack from scratch.
  let step = 'createOffer';
  let response: Response;
  try {
    const offer = await peer.createOffer();

    step = 'setLocalDescription';
    await peer.setLocalDescription(offer);

    step = `POST ${VOICE_CALL_ROUTE}`;
    response = await fetchImpl(VOICE_CALL_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sdp: offer.sdp,
        conversationId: deps.target.conversationId,
        ...(deps.timezone === undefined ? {} : { timezone: deps.timezone }),
        ...(deps.locationContext === undefined
          ? {}
          : { locationContext: deps.locationContext }),
      }),
    });
  } catch (error) {
    stop();
    return failure(
      'signaling-failed',
      `${step} — ${describeThrown(error)}`,
      ROUTE_MESSAGES['signaling-failed'],
    );
  }

  if (!response.ok) {
    stop();
    const reason = failureForStatus(response.status);
    const { message, detail } = await readRouteError(response);
    // The route writes the sentence for its own refusals; ours is the fallback,
    // never the override — it is the one that knows about the upgrade path.
    return failure(reason, detail, message ?? ROUTE_MESSAGES[reason]);
  }

  let callId: string;
  let attached: boolean;
  let maxDurationMs: number | undefined;
  try {
    const body = (await response.json()) as {
      callId?: unknown;
      answerSdp?: unknown;
      attached?: unknown;
      maxDurationMs?: unknown;
    };
    if (typeof body.callId !== 'string' || body.callId.length === 0) {
      stop();
      return failure(
        'signaling-failed',
        'call response carried no callId',
        ROUTE_MESSAGES['signaling-failed'],
      );
    }
    if (typeof body.answerSdp !== 'string' || body.answerSdp.length === 0) {
      stop();
      return failure(
        'signaling-failed',
        'call response carried no answer SDP',
        ROUTE_MESSAGES['signaling-failed'],
      );
    }
    callId = body.callId;
    attached = body.attached === true;
    maxDurationMs =
      typeof body.maxDurationMs === 'number' ? body.maxDurationMs : undefined;

    await peer.setRemoteDescription({ type: 'answer', sdp: body.answerSdp });
  } catch (error) {
    stop();
    return failure(
      'signaling-failed',
      `answer — ${describeThrown(error)}`,
      ROUTE_MESSAGES['signaling-failed'],
    );
  }

  return {
    ok: true,
    connection: {
      callId,
      attached,
      maxDurationMs,
      microphone,
      setMicrophoneEnabled,
      stop,
    },
  };
};
