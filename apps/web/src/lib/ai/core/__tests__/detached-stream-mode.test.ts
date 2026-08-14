import { describe, it, expect } from 'vitest';
import {
  ADMISSION_ENVELOPE_CONTENT_TYPE,
  STREAM_MODE_DETACHED,
  STREAM_MODE_HEADER,
  parseAdmissionEnvelope,
  readAdmissionEnvelope,
  synthesizeStartChunk,
  wantsDetachedStream,
} from '../detached-stream-mode';

const validEnvelope = {
  // `as const` so `mode` keeps its literal type — the envelope interface pins it to
  // 'detached', which is what makes an unrecognised mode a compile error rather than a
  // runtime surprise.
  mode: STREAM_MODE_DETACHED as typeof STREAM_MODE_DETACHED,
  messageId: 'msg-1',
  conversationId: 'conv-1',
  channelId: 'page-1',
  streamId: 'stream-1',
  startedAt: '2026-08-14T10:00:00.000Z',
};

const envelopeResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': ADMISSION_ENVELOPE_CONTENT_TYPE },
  });

describe('wantsDetachedStream — the server never volunteers the envelope', () => {
  it('given the header, wants a receipt', () => {
    const headers = new Headers({ [STREAM_MODE_HEADER]: STREAM_MODE_DETACHED });
    expect(wantsDetachedStream(headers)).toBe(true);
  });

  it('given NO header, wants the body — this is what keeps an old client working', () => {
    // An old tab left open across a deploy sends nothing. If the server switched unilaterally,
    // that tab would receive JSON where it expected SSE and every reply would vanish.
    expect(wantsDetachedStream(new Headers())).toBe(false);
  });

  it('given a differently-cased value, still wants a receipt', () => {
    // Header VALUES survive proxies unpredictably; the name lookup is already case-insensitive.
    expect(wantsDetachedStream(new Headers({ [STREAM_MODE_HEADER]: ' Detached ' }))).toBe(true);
  });

  it('given an unrecognised mode, falls back to the body rather than guessing', () => {
    expect(wantsDetachedStream(new Headers({ [STREAM_MODE_HEADER]: 'chunked' }))).toBe(false);
  });
});

describe('readAdmissionEnvelope — null means "fall through to the legacy body"', () => {
  it('given a well-formed envelope, returns it', async () => {
    expect(await readAdmissionEnvelope(envelopeResponse(validEnvelope))).toEqual(validEnvelope);
  });

  it('given an SSE response from an OLD SERVER, returns null and leaves the body readable', async () => {
    // The case that makes the client safe to deploy FIRST. Null is the caller's instruction to
    // read the body — so this must not have consumed it.
    const sse = new Response('data: {"type":"start","messageId":"msg-1"}\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    expect(await readAdmissionEnvelope(sse)).toBeNull();
    expect(sse.bodyUsed).toBe(false);
    await expect(sse.text()).resolves.toContain('msg-1');
  });

  it('given an ERROR body that happens to be JSON, returns null rather than a fake admission', async () => {
    // Why the content type is bespoke rather than `application/json`. A client that treated any
    // JSON as an envelope would read a 500's `{ error }` as an admission and then subscribe to
    // a stream that does not exist — hanging on a join that 404s instead of surfacing the error.
    const errorBody = new Response(JSON.stringify({ error: 'boom' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
    expect(await readAdmissionEnvelope(errorBody)).toBeNull();
  });

  it('given the envelope content type but unparseable bytes, returns null', async () => {
    const broken = new Response('not json at all', {
      status: 200,
      headers: { 'content-type': ADMISSION_ENVELOPE_CONTENT_TYPE },
    });
    expect(await readAdmissionEnvelope(broken)).toBeNull();
  });
});

describe('parseAdmissionEnvelope — every field is load-bearing', () => {
  it.each(['messageId', 'conversationId', 'channelId', 'streamId', 'startedAt'])(
    'given an envelope missing %s, refuses it',
    (field) => {
      const partial: Record<string, unknown> = { ...validEnvelope };
      delete partial[field];
      // An envelope missing a field is not a degraded envelope, it is an unusable one — without
      // `messageId` there is nothing to subscribe to, nothing to key the store on, and nothing
      // for Stop to name.
      expect(parseAdmissionEnvelope(partial)).toBeNull();
    },
  );

  it('given an empty-string field, refuses it', () => {
    expect(parseAdmissionEnvelope({ ...validEnvelope, messageId: '' })).toBeNull();
  });

  it('given a non-object, refuses it', () => {
    expect(parseAdmissionEnvelope(null)).toBeNull();
    expect(parseAdmissionEnvelope('detached')).toBeNull();
  });

  it('given the wrong mode, refuses it', () => {
    expect(parseAdmissionEnvelope({ ...validEnvelope, mode: 'body' })).toBeNull();
  });
});

describe('synthesizeStartChunk — the frame a mid-seq joiner will never receive', () => {
  it('carries the messageId the ENVELOPE stated, not one read off frame content', () => {
    // THE sharpest bug in this workstream. `sdkServerIdAdoption.test.ts` pins that `Chat`
    // adopts the assistant id from the `start` chunk — and on a mid-seq join that frame is
    // behind the cursor and will never arrive. A client that infers the id gets nothing,
    // invents one, and renders two assistant bubbles for one reply.
    const chunk = synthesizeStartChunk(validEnvelope) as { type: string; messageId: string };

    expect(chunk.type).toBe('start');
    expect(chunk.messageId).toBe('msg-1');
  });

  it('produces the SAME id on a resume as on a fresh join', () => {
    // Both come from the lifecycle's `messageId`, so a reseed after a `resumeFromSeq` writes to
    // the store entry that already exists rather than opening a second one beside it.
    const fresh = synthesizeStartChunk(validEnvelope) as { messageId: string };
    const resumed = synthesizeStartChunk({ ...validEnvelope }) as { messageId: string };
    expect(resumed.messageId).toBe(fresh.messageId);
  });
});
