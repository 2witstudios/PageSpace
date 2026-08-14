import { describe, it, expect } from 'vitest';
import { readInlineReply } from '../inline-reply';

const sse = (records: string[]) =>
  new Response(records.map((r) => `data: ${r}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

describe('readInlineReply', () => {
  it('reads the WHOLE reply, not just its start frame', async () => {
    // The opposite rule to `readLegacyStreamStart`: there is no channel to hand over to, so
    // stopping early would discard the answer outright — which is exactly what /help did when
    // it was mistaken for an old server's streamed body.
    const reply = await readInlineReply(
      sse([
        '{"type":"start","messageId":"msg-help"}',
        '{"type":"text-start","id":"t1"}',
        '{"type":"text-delta","id":"t1","delta":"here is "}',
        '{"type":"text-delta","id":"t1","delta":"the help"}',
        '{"type":"text-end","id":"t1"}',
      ]),
    );

    expect(reply?.messageId).toBe('msg-help');
    expect(JSON.stringify(reply?.parts)).toContain('here is the help');
  });

  it('folds non-text parts with the same reduction the live path uses', async () => {
    // An inline reply and a streamed one must render identically.
    const reply = await readInlineReply(
      sse([
        '{"type":"start","messageId":"msg-help"}',
        '{"type":"data-command-execution","data":{"command":"/help"}}',
      ]),
    );
    expect(reply?.parts.map((p) => p.type)).toContain('data-command-execution');
  });

  it('given a body that never names its message, returns null', async () => {
    expect(await readInlineReply(sse(['{"type":"text-delta","id":"t1","delta":"x"}']))).toBeNull();
  });

  it('given no body, returns null rather than throwing', async () => {
    expect(await readInlineReply(new Response(null, { status: 200 }))).toBeNull();
  });

  it('tolerates a malformed line without losing the rest of the reply', async () => {
    const body = new Response(
      'data: {"type":"start","messageId":"msg-help"}\n\ndata: NOT JSON\n\n'
        + 'data: {"type":"text-start","id":"t1"}\n\ndata: {"type":"text-delta","id":"t1","delta":"kept"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    const reply = await readInlineReply(body);
    expect(JSON.stringify(reply?.parts)).toContain('kept');
  });
});
