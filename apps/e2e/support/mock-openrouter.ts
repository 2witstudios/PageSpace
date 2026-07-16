import http from 'http';

/**
 * Mock OpenRouter / OpenAI-compatible chat-completions server for metering e2e.
 *
 * The web app, started with OPENROUTER_BASE_URL pointed here (and an
 * OPENROUTER_DEFAULT_API_KEY set), routes its AI calls to this stub instead of the
 * real OpenRouter. The stub returns a deterministic completion that carries
 * `usage.cost` — the authoritative per-request cost PageSpace bills on
 * (providerMetadata.openrouter.usage.cost). That makes the credit debit assertable
 * end-to-end: a known cost in → a known charge out (cost × 1.5 markup).
 *
 * It also records every chat-completions hit so a test can prove the OPPOSITE: that a
 * blocked (out-of-credits / over-cap) request NEVER reached the model. Introspection is
 * exposed over HTTP (not in-process state) so the Playwright worker — a different
 * process from this server — can read it:
 *   GET  /__health  → { ok: true }
 *   GET  /__calls   → { count, requests: [{ model, stream, messages }] }
 *   POST /__reset   → zeroes the recorder, releases open streams, restores stream config
 *
 * Streaming pacing is controllable, so a spec can assert against a live window instead of a
 * stream that is over before the browser sees it:
 *   POST /__stream-config  → { mode?: 'instant'|'slow'|'held', chunks?, intervalMs? }
 *   GET  /__streams        → { open, held, mode } — wait for a stream to actually be live
 *   POST /__release-stream → flush + terminate every held stream
 *
 * `mode` is the control a UI spec MUST use. Model-name triggers (`e2e/slow-stream`,
 * `e2e/held-stream`) also work, but ONLY for callers that reach this server directly: the app
 * rewrites any model id outside its static catalog to DEFAULT_MODEL before calling the
 * provider (`resolveProviderModel`), so a pacing model name never survives a real send.
 *
 * With no mode configured and an ordinary model, behavior is the original instant path,
 * byte-for-byte — which is what keeps metering specs 09-14 unaffected. `/__reset` clears the
 * mode, so a held stream can never leak into the next spec.
 *
 * It also serves OpenRouter's authoritative cost-reconcile endpoint:
 *   GET  /generation?id=<id> → { data: { total_cost: <number> } }
 * so the reconcile cron (cost-reconcile.ts) can fetch a FINAL cost that differs from the
 * inline completion cost and induce a billing drift. The reported cost defaults to
 * MOCK_GENERATION_COST_DOLLARS and is overridable per-id (and globally) via POST /__set-generation-cost.
 */

/** Real provider cost in US dollars returned for every completion. 0.02 → 2¢ real → 3¢ charged at 1.5×. */
export const MOCK_COST_DOLLARS = 0.02;
/**
 * Default authoritative `/generation` total_cost (dollars) returned to the reconcile cron.
 * Higher than MOCK_COST_DOLLARS so, left at the default, the cron sees an undercharge drift.
 */
export const MOCK_GENERATION_COST_DOLLARS = 0.05;
export const MOCK_PROMPT_TOKENS = 12;
export const MOCK_COMPLETION_TOKENS = 4;

/**
 * Pacing modes. `POST /__stream-config { mode }` selects one.
 *
 * This — NOT the model name — is what a UI spec must use. The app rewrites any model id it
 * does not know to its DEFAULT_MODEL before calling the provider
 * (`resolveProviderModel` → `isValidModel`, apps/web/src/lib/ai/core/ai-providers-config.ts),
 * so `e2e/slow-stream` never survives a real send. The mode is applied regardless of the
 * model that arrives, which is exactly what makes it survive that substitution.
 */
export type StreamMode = 'instant' | 'slow' | 'held';

/**
 * Model name that paces chunks on a timer. Only reachable when a caller talks to the mock
 * DIRECTLY (support tests) — a send through the app is model-substituted before it gets here,
 * so UI specs must use `POST /__stream-config { mode: 'slow' }` instead.
 */
export const E2E_SLOW_STREAM_MODEL = 'e2e/slow-stream';
/** Direct-to-mock counterpart of E2E_SLOW_STREAM_MODEL for the held mode. See above. */
export const E2E_HELD_STREAM_MODEL = 'e2e/held-stream';

/** Default slow-mode pacing: 40 × 250ms ≈ a 10s window. Overridable via POST /__stream-config. */
export const DEFAULT_STREAM_CHUNKS = 40;
export const DEFAULT_STREAM_INTERVAL_MS = 250;

interface RecordedRequest {
  model: string | undefined;
  stream: boolean;
  messageCount: number;
}

/** A chat-completions stream the mock is still writing to (slow-paced or held). */
interface ActiveStream {
  held: boolean;
  /** Flush any remaining content, then the usage chunk + [DONE], and end the response. */
  finish: () => void;
  /** Abandon the stream without writing (client went away). */
  drop: () => void;
}

export function createMockOpenRouter() {
  const requests: RecordedRequest[] = [];
  // Authoritative /generation cost (dollars) the reconcile cron reads, keyed by generation
  // id. A test sets these via POST /__set-generation-cost; unknown ids fall back to the
  // default so a plain reconcile run still produces a deterministic drift.
  const generationCosts = new Map<string, number>();
  let defaultGenerationCost = MOCK_GENERATION_COST_DOLLARS;

  // Streams currently open (slow-paced or held). Tracked so /__streams can report a live
  // window, /__release-stream can flush the held ones, and /__reset + server close can
  // guarantee nothing leaks across specs or pins the event loop.
  const activeStreams = new Set<ActiveStream>();
  let streamChunks = DEFAULT_STREAM_CHUNKS;
  let streamIntervalMs = DEFAULT_STREAM_INTERVAL_MS;
  // Applied to every streaming completion whatever model it names. `null` means "no override
  // configured" — distinct from an explicit 'instant', which deliberately overrides the
  // model-name triggers below. Specs that never set a mode (09-14) leave this null and see the
  // original behavior unchanged.
  let streamMode: StreamMode | null = null;

  const completionUsage = {
    prompt_tokens: MOCK_PROMPT_TOKENS,
    completion_tokens: MOCK_COMPLETION_TOKENS,
    total_tokens: MOCK_PROMPT_TOKENS + MOCK_COMPLETION_TOKENS,
    // OpenRouter's usage-accounting cost. The AI SDK surfaces this under
    // providerMetadata.openrouter.usage.cost, which trackAIUsage bills on.
    cost: MOCK_COST_DOLLARS,
  };

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });
  }

  function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
  }

  const chunkBase = (id: string, model: string) => ({
    id,
    provider: 'e2e',
    model,
    object: 'chat.completion.chunk',
    created: 0,
  });

  const contentChunkOf = (id: string, model: string, content: string) => ({
    ...chunkBase(id, model),
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  });

  /**
   * Final chunk carries finish_reason + usage (with cost) — OpenRouter's shape when
   * usage:{include:true} is set on the request. Keeping this identical across all modes is
   * what keeps provider parsing and billing settlement real for the paced streams too.
   */
  const finalChunkOf = (id: string, model: string) => ({
    ...chunkBase(id, model),
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: completionUsage,
  });

  /** Every write goes through here: a destroyed socket (client aborted) must never throw. */
  function writeSse(res: http.ServerResponse, payload: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  /**
   * Open a controllable SSE stream and register it in `activeStreams`.
   *
   * slow mode paces `streamChunks` content chunks `streamIntervalMs` apart; held mode
   * writes the first chunk and then waits for a release. Both terminate through the same
   * `finish()` so the wire shape (usage chunk + [DONE]) is mode-independent.
   */
  function startControlledStream(
    res: http.ServerResponse,
    id: string,
    model: string,
    mode: 'slow' | 'held',
  ): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const total = Math.max(1, streamChunks);
    let sent = 0;
    let timer: NodeJS.Timeout | undefined;

    const sendNext = (): void => {
      writeSse(res, contentChunkOf(id, model, `chunk-${sent} `));
      sent += 1;
    };

    const cleanup = (): void => {
      if (timer) clearInterval(timer);
      timer = undefined;
      activeStreams.delete(entry);
    };

    const finish = (): void => {
      cleanup();
      // Flush whatever the pacing/hold never got to, so a released stream always lands on
      // the same terminal shape as a naturally-completed one.
      while (sent < total) sendNext();
      writeSse(res, finalChunkOf(id, model));
      if (!res.writableEnded && !res.destroyed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    };

    const entry: ActiveStream = { held: mode === 'held', finish, drop: cleanup };
    activeStreams.add(entry);

    // The client hung up (user hit Stop, or the app aborted upstream): stop the timer and
    // stop writing. Nothing here may throw — 7.4's Stop spec depends on it. This is the
    // connection-level close, not `req`'s (which fires as soon as the request body has
    // been consumed, long before the client goes away). Idempotent with finish()'s
    // cleanup, so a naturally-completed stream lands here harmlessly too.
    res.on('close', cleanup);

    // First chunk immediately in both modes: the UI gets a live bubble to assert against
    // without waiting out an interval.
    sendNext();

    if (mode === 'held') return; // ...and there it stays, until POST /__release-stream.

    if (sent >= total) return finish();
    timer = setInterval(() => {
      sendNext();
      if (sent >= total) finish();
    }, Math.max(1, streamIntervalMs));
  }

  /** Terminate every open stream (or only the held ones) through the normal finish path. */
  function finishStreams(only: 'held' | 'all'): number {
    const targets = [...activeStreams].filter((s) => only === 'all' || s.held);
    for (const s of targets) s.finish();
    return targets.length;
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.startsWith('/__health')) {
      return writeJson(res, 200, { ok: true });
    }
    if (method === 'GET' && url.startsWith('/__calls')) {
      return writeJson(res, 200, { count: requests.length, requests });
    }
    if (method === 'POST' && url.startsWith('/__reset')) {
      requests.length = 0;
      generationCosts.clear();
      defaultGenerationCost = MOCK_GENERATION_COST_DOLLARS;
      // A held stream must never leak into the next spec: terminate every open stream and
      // restore default pacing.
      finishStreams('all');
      streamChunks = DEFAULT_STREAM_CHUNKS;
      streamIntervalMs = DEFAULT_STREAM_INTERVAL_MS;
      streamMode = null;
      return writeJson(res, 200, { ok: true });
    }
    // Live-stream introspection: lets a spec expect.poll() until the app's request has
    // actually reached the model, instead of racing the UI with a sleep.
    if (method === 'GET' && url.startsWith('/__streams')) {
      const open = activeStreams.size;
      const held = [...activeStreams].filter((s) => s.held).length;
      // `mode` is reported so a spec (or a human debugging one) can tell "the stream already
      // finished" apart from "the mode never took effect" — the two look identical from
      // open:0 alone, and the difference is the whole ballgame.
      return writeJson(res, 200, { open, held, mode: streamMode ?? 'instant' });
    }
    // Select the pacing mode and/or override slow-mode pacing.
    // Body: { mode?: 'instant'|'slow'|'held', chunks?, intervalMs? }. Reset by /__reset.
    if (method === 'POST' && url.startsWith('/__stream-config')) {
      const raw = await readBody(req);
      let body: { chunks?: number; intervalMs?: number; mode?: StreamMode } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        /* ignore — keep current config */
      }
      if (body.mode === 'instant' || body.mode === 'slow' || body.mode === 'held') {
        streamMode = body.mode;
      }
      if (typeof body.chunks === 'number' && body.chunks > 0) streamChunks = body.chunks;
      if (typeof body.intervalMs === 'number' && body.intervalMs >= 0) {
        streamIntervalMs = body.intervalMs;
      }
      return writeJson(res, 200, {
        ok: true,
        mode: streamMode,
        chunks: streamChunks,
        intervalMs: streamIntervalMs,
      });
    }
    // Flush + terminate every held stream, ending the deterministic live window.
    if (method === 'POST' && url.startsWith('/__release-stream')) {
      return writeJson(res, 200, { ok: true, released: finishStreams('held') });
    }
    // Override the authoritative /generation cost. Body: { id?, totalCost } — with `id`
    // sets that generation's cost, without it sets the default for all unknown ids.
    if (method === 'POST' && url.startsWith('/__set-generation-cost')) {
      const raw = await readBody(req);
      let body: { id?: string; totalCost?: number } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        /* ignore */
      }
      if (typeof body.totalCost === 'number') {
        if (typeof body.id === 'string' && body.id.length > 0) generationCosts.set(body.id, body.totalCost);
        else defaultGenerationCost = body.totalCost;
      }
      return writeJson(res, 200, { ok: true });
    }
    // OpenRouter's authoritative cost endpoint, polled by the reconcile cron. Matched by
    // `includes` because the cron hits it under the /api/v1 base path.
    if (method === 'GET' && url.includes('/generation')) {
      const id = new URL(url, 'http://127.0.0.1').searchParams.get('id') ?? '';
      const totalCost = generationCosts.has(id) ? generationCosts.get(id)! : defaultGenerationCost;
      return writeJson(res, 200, { data: { total_cost: totalCost } });
    }

    if (method === 'POST' && url.includes('/chat/completions')) {
      const raw = await readBody(req);
      let body: { model?: string; stream?: boolean; messages?: unknown[] } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        /* ignore — record as empty */
      }
      const stream = body.stream === true;
      requests.push({
        model: body.model,
        stream,
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      });

      const id = 'gen-e2e-stub';
      const model = body.model ?? 'e2e/stub';

      if (stream) {
        // An explicitly configured mode always wins — including 'instant', which is how a
        // direct-to-mock caller opts OUT of the model-name triggers. The model name cannot be
        // relied on for app-driven sends: the app rewrites unknown ids to its DEFAULT_MODEL
        // before calling the provider. With no mode configured and an ordinary model this
        // yields 'instant' and falls through to the original path, untouched.
        const mode: StreamMode =
          streamMode ??
          (model === E2E_SLOW_STREAM_MODEL
            ? 'slow'
            : model === E2E_HELD_STREAM_MODEL
              ? 'held'
              : 'instant');
        if (mode !== 'instant') return startControlledStream(res, id, model, mode);

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(contentChunkOf(id, model, 'pong'))}\n\n`);
        res.write(`data: ${JSON.stringify(finalChunkOf(id, model))}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      return writeJson(res, 200, {
        id,
        provider: 'e2e',
        model,
        object: 'chat.completion',
        created: 0,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop',
          },
        ],
        usage: completionUsage,
      });
    }

    writeJson(res, 404, { error: `mock-openrouter: unhandled ${method} ${url}` });
  });

  // server.close() waits for open connections and would hang forever on a held stream —
  // and a live chunk timer keeps the event loop pinned. Terminate both on close.
  const close = server.close.bind(server);
  server.close = (cb?: (err?: Error) => void) => {
    finishStreams('all');
    return close(cb);
  };

  return server;
}
