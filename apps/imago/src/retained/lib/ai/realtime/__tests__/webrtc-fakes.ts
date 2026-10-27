/**
 * Fakes for the three browser capabilities a voice call needs: a peer
 * connection, a microphone, and a data channel.
 *
 * jsdom implements none of them, and a live call cannot be a unit test — so
 * these stand in, and they record enough (tracks stopped, connections closed,
 * descriptions applied) that teardown can be ASSERTED rather than assumed. A
 * leaked microphone is invisible in production until someone notices the
 * recording indicator is still on.
 */

export class FakeTrack {
  public enabled = true;
  public stopped = false;
  public readonly kind = 'audio';

  constructor(public readonly id: string) {}

  stop(): void {
    this.stopped = true;
  }

  /** A clone shares the device but is independent: stopping one leaves the other live. */
  clone(): FakeTrack {
    return new FakeTrack(`${this.id}:clone`);
  }
}

export class FakeStream {
  constructor(public readonly tracks: FakeTrack[]) {}

  getTracks(): FakeTrack[] {
    return this.tracks;
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
}

export const fakeStream = (...ids: string[]): FakeStream =>
  new FakeStream(ids.map((id) => new FakeTrack(id)));

export class FakeDataChannel {
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public closed = false;

  constructor(public readonly label: string) {}

  close(): void {
    this.closed = true;
  }

  /** Drive a frame in from the model. */
  deliver(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

export class FakePeerConnection {
  public connectionState: RTCPeerConnectionState = 'new';
  public onconnectionstatechange: (() => void) | null = null;
  public ontrack: ((event: RTCTrackEvent) => void) | null = null;
  public closed = false;
  public readonly addedTracks: FakeTrack[] = [];
  public readonly channels: FakeDataChannel[] = [];
  public localDescription: RTCSessionDescriptionInit | null = null;
  public remoteDescription: RTCSessionDescriptionInit | null = null;
  /** Set to make `createOffer` reject, standing in for a broken transport. */
  public failOn: 'createOffer' | 'setRemoteDescription' | null = null;

  constructor(public readonly offerSdp = 'v=0 fake offer') {}

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (this.failOn === 'createOffer') throw new Error('no transport');
    return { type: 'offer', sdp: this.offerSdp };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    if (this.failOn === 'setRemoteDescription') {
      throw new Error('unparseable answer');
    }
    this.remoteDescription = description;
  }

  addTrack(track: FakeTrack): void {
    this.addedTracks.push(track);
  }

  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel;
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
    // Real peer connections DO fire the state change on close. Firing it here
    // is what proves `stop` detaches the handler rather than relying on the
    // caller to ignore a loss it caused itself.
    this.onconnectionstatechange?.();
  }

  /** Drive a spontaneous connection state change, the way a dropped call does. */
  transitionTo(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  /** Deliver the model's voice. */
  deliverRemoteTrack(stream: FakeStream): void {
    this.ontrack?.({ streams: [stream] } as unknown as RTCTrackEvent);
  }

  get events(): FakeDataChannel {
    const channel = this.channels[0];
    if (!channel) throw new Error('no data channel was opened');
    return channel;
  }
}

/** The shapes above, narrowed to what the production types demand. */
export const asPeer = (peer: FakePeerConnection): RTCPeerConnection =>
  peer as unknown as RTCPeerConnection;

export const asStream = (stream: FakeStream): MediaStream =>
  stream as unknown as MediaStream;

/** `new MediaStream(tracks)` does not exist in jsdom; this is its stand-in. */
export const fakeCreateMediaStream = (tracks: MediaStreamTrack[]): MediaStream =>
  asStream(new FakeStream(tracks as unknown as FakeTrack[]));

export type JsonResponse = {
  readonly status?: number;
  readonly body?: unknown;
  /** Raw text, for asserting a non-JSON error body is handled. */
  readonly text?: string;
};

/** A `fetch` stand-in returning one canned response. */
export const respondWith = ({
  status = 200,
  body,
  text,
}: JsonResponse): Response => {
  const payload = text ?? JSON.stringify(body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => payload,
    json: async () => JSON.parse(payload) as unknown,
  } as unknown as Response;
};

export const CALL_OK = {
  callId: 'rtc_call_one',
  answerSdp: 'v=0 fake answer',
  attached: true,
  maxDurationMs: 600_000,
};
