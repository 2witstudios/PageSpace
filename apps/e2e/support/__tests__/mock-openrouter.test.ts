import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import {
  createMockOpenRouter,
  E2E_SLOW_STREAM_MODEL,
  E2E_HELD_STREAM_MODEL,
  MOCK_COST_DOLLARS,
} from '../mock-openrouter';

/**
 * Support-level tests for the controllable stream modes (7.0a). They drive the mock over
 * real HTTP — the same surface the web app and the Playwright specs use — so the pacing,
 * the hold/release handshake and the abort safety are proven without a database, a web
 * app, or a browser.
 *
 * The default (instant) path is asserted here too: metering specs 09-14 depend on it and
 * this leaf must not perturb it.
 */

let server: Server;
let base: string;

beforeAll(async () => {
  server = createMockOpenRouter();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

afterEach(async () => {
  await fetch(`${base}/__reset`, { method: 'POST' });
});

interface ParsedChunk {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
  usage?: { cost?: number };
}

/** `Array.prototype.at` is past this tsconfig's lib target. */
const last = <T>(arr: T[]): T | undefined => arr[arr.length - 1];

/** Split an SSE body into its parsed `data:` payloads, dropping the [DONE] sentinel. */
function parseSse(body: string): { chunks: ParsedChunk[]; done: boolean } {
  const datas = body
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length));
  return {
    chunks: datas.filter((d) => d !== '[DONE]').map((d) => JSON.parse(d) as ParsedChunk),
    done: datas.includes('[DONE]'),
  };
}

function completions(model: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'ping' }] }),
    signal,
  });
}

async function readStreams(): Promise<{ open: number; held: number }> {
  const res = await fetch(`${base}/__streams`);
  return (await res.json()) as { open: number; held: number };
}

/** Read an SSE response to completion, timestamping each content chunk as it arrives. */
async function readWithTimings(res: Response): Promise<{ body: string; contentAt: number[] }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let body = '';
  const contentAt: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    body += text;
    for (const _ of text.matchAll(/"content":"/g)) contentAt.push(Date.now());
  }
  return { body, contentAt };
}

describe('mock OpenRouter — default (instant) path is untouched', () => {
  it('given an ordinary model, should stream one content chunk + usage + [DONE] and end', async () => {
    const res = await completions('e2e/stub-model');
    const { chunks, done } = parseSse(await res.text());

    const contents = chunks.flatMap((c) => c.choices?.[0]?.delta?.content ?? []);
    expect(contents).toEqual(['pong']);
    expect(last(chunks)?.usage?.cost).toBe(MOCK_COST_DOLLARS);
    expect(done).toBe(true);
  });

  it('given a non-stream request, should return a JSON completion carrying usage.cost', async () => {
    const res = await fetch(`${base}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'e2e/stub-model', messages: [] }),
    });
    const json = (await res.json()) as ParsedChunk & {
      choices: { message: { content: string } }[];
    };
    expect(json.choices[0].message.content).toBe('pong');
    expect(json.usage?.cost).toBe(MOCK_COST_DOLLARS);
  });
});

describe('mock OpenRouter — slow-stream mode', () => {
  it('given the slow-stream model, should deliver >2 content chunks separated in time, then usage + [DONE]', async () => {
    await fetch(`${base}/__stream-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chunks: 4, intervalMs: 60 }),
    });

    const res = await completions(E2E_SLOW_STREAM_MODEL);
    const { body, contentAt } = await readWithTimings(res);
    const { chunks, done } = parseSse(body);

    const contents = chunks.flatMap((c) => c.choices?.[0]?.delta?.content ?? []);
    expect(contents.length).toBe(4);
    expect(contents.length).toBeGreaterThan(2);
    // Separated in time: the pacing is real, not a synchronous burst.
    expect(last(contentAt)! - contentAt[0]).toBeGreaterThanOrEqual(60);
    expect(last(chunks)?.usage?.cost).toBe(MOCK_COST_DOLLARS);
    expect(last(chunks)?.choices?.[0]?.finish_reason).toBe('stop');
    expect(done).toBe(true);
  });

  it('given a completed slow stream, should leave no open streams behind', async () => {
    await fetch(`${base}/__stream-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chunks: 2, intervalMs: 10 }),
    });
    const res = await completions(E2E_SLOW_STREAM_MODEL);
    await res.text();

    expect(await readStreams()).toEqual({ open: 0, held: 0 });
  });
});

describe('mock OpenRouter — held-stream mode', () => {
  it('given the held-stream model, should send a first chunk and stay open until released', async () => {
    const res = await completions(E2E_HELD_STREAM_MODEL);
    const reader = res.body!.getReader();

    // First chunk arrives immediately — the UI has a live bubble to assert on.
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"content":"');
    expect(first).not.toContain('[DONE]');

    await expect.poll(readStreams).toEqual({ open: 1, held: 1 });

    await fetch(`${base}/__release-stream`, { method: 'POST' });

    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    const { chunks, done } = parseSse(rest);
    expect(last(chunks)?.usage?.cost).toBe(MOCK_COST_DOLLARS);
    expect(done).toBe(true);
    expect(await readStreams()).toEqual({ open: 0, held: 0 });
  });

  it('given two held streams, should release both on one /__release-stream', async () => {
    const [a, b] = await Promise.all([
      completions(E2E_HELD_STREAM_MODEL),
      completions(E2E_HELD_STREAM_MODEL),
    ]);
    await expect.poll(readStreams).toEqual({ open: 2, held: 2 });

    await fetch(`${base}/__release-stream`, { method: 'POST' });
    const [bodyA, bodyB] = await Promise.all([a.text(), b.text()]);

    expect(parseSse(bodyA).done).toBe(true);
    expect(parseSse(bodyB).done).toBe(true);
    expect(await readStreams()).toEqual({ open: 0, held: 0 });
  });
});

describe('mock OpenRouter — abort safety and reset', () => {
  it('given a client that aborts mid-stream, should drop the stream without crashing the server', async () => {
    await fetch(`${base}/__stream-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chunks: 50, intervalMs: 30 }),
    });
    const controller = new AbortController();
    const res = await completions(E2E_SLOW_STREAM_MODEL, controller.signal);
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();

    // The server survives and stops accounting the aborted stream.
    await expect.poll(readStreams).toEqual({ open: 0, held: 0 });
    const health = await fetch(`${base}/__health`);
    expect(await health.json()).toEqual({ ok: true });
  });

  it('given a held stream, should release it and restore default config on /__reset', async () => {
    const res = await completions(E2E_HELD_STREAM_MODEL);
    await expect.poll(readStreams).toEqual({ open: 1, held: 1 });

    await fetch(`${base}/__reset`, { method: 'POST' });

    const { done } = parseSse(await res.text());
    expect(done, 'a held stream must not leak across specs').toBe(true);
    expect(await readStreams()).toEqual({ open: 0, held: 0 });

    const calls = await fetch(`${base}/__calls`);
    expect(((await calls.json()) as { count: number }).count).toBe(0);
  });

  it('given stream modes are used, should still record calls for the metering recorder', async () => {
    await fetch(`${base}/__stream-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chunks: 1, intervalMs: 5 }),
    });
    const res = await completions(E2E_SLOW_STREAM_MODEL);
    await res.text();

    const calls = await fetch(`${base}/__calls`);
    const json = (await calls.json()) as { count: number; requests: { model: string }[] };
    expect(json.count).toBe(1);
    expect(json.requests[0].model).toBe(E2E_SLOW_STREAM_MODEL);
  });
});
