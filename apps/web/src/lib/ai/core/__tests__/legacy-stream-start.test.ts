import { describe, it, expect } from 'vitest';
import { readLegacyStreamStart } from '../legacy-stream-start';

const sse = (records: string[], opts: { trailing?: boolean } = {}) =>
  new Response(records.map((r) => `data: ${r}\n\n`).join('') + (opts.trailing ? 'data: ' : ''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

describe('readLegacyStreamStart', () => {
  it('returns the server-issued messageId from the start frame', async () => {
    const body = sse([
      '{"type":"start","messageId":"msg-legacy"}',
      '{"type":"text-delta","id":"t1","delta":"hello"}',
    ]);
    expect(await readLegacyStreamStart(body)).toBe('msg-legacy');
  });

  it('STOPS at the start frame rather than draining the reply', async () => {
    // The whole point: reading on would make the caller a second writer racing the socket's
    // own join for the same store entry.
    const body = sse([
      '{"type":"start","messageId":"msg-legacy"}',
      '{"type":"text-delta","id":"t1","delta":"a"}',
      '{"type":"text-delta","id":"t1","delta":"b"}',
    ]);
    await readLegacyStreamStart(body);
    // The body is released, not drained to completion.
    expect(body.bodyUsed || body.body?.locked).toBeTruthy();
  });

  it('given a body that ENDS without a start frame, returns undefined', async () => {
    // A provider auth failure or a truncated response. The caller must treat this as a FAILED
    // send — reporting success here is how a send clears the composer while rendering nothing.
    expect(await readLegacyStreamStart(sse(['{"type":"error","errorText":"boom"}']))).toBeUndefined();
  });

  it('given an empty body, returns undefined', async () => {
    expect(await readLegacyStreamStart(sse([]))).toBeUndefined();
  });

  it('given no body at all, returns undefined rather than throwing', async () => {
    expect(await readLegacyStreamStart(new Response(null, { status: 200 }))).toBeUndefined();
  });

  it('skips malformed lines before the start frame', async () => {
    const body = new Response(
      'data: not json\n\n: a comment\n\ndata: {"type":"start","messageId":"msg-late"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    expect(await readLegacyStreamStart(body)).toBe('msg-late');
  });

  it('given a start frame with no messageId, keeps looking rather than accepting it', async () => {
    const body = sse(['{"type":"start"}', '{"type":"start","messageId":"msg-real"}']);
    expect(await readLegacyStreamStart(body)).toBe('msg-real');
  });

  it('given a start frame split across two network chunks, still finds it', async () => {
    // SSE arrives in arbitrary byte chunks; the reader must buffer across reads.
    const encoder = new TextEncoder();
    const parts = ['data: {"type":"st', 'art","messageId":"msg-split"}\n\n'];
    let i = 0;
    const body = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i >= parts.length) return controller.close();
          controller.enqueue(encoder.encode(parts[i++]));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    expect(await readLegacyStreamStart(body)).toBe('msg-split');
  });
});
