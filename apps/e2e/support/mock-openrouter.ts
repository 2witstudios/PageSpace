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
 *   POST /__reset   → zeroes the recorder
 */

/** Real provider cost in US dollars returned for every completion. 0.02 → 2¢ real → 3¢ charged at 1.5×. */
export const MOCK_COST_DOLLARS = 0.02;
export const MOCK_PROMPT_TOKENS = 12;
export const MOCK_COMPLETION_TOKENS = 4;

interface RecordedRequest {
  model: string | undefined;
  stream: boolean;
  messageCount: number;
}

export function createMockOpenRouter() {
  const requests: RecordedRequest[] = [];

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
      return writeJson(res, 200, { ok: true });
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
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const contentChunk = {
          id,
          provider: 'e2e',
          model,
          object: 'chat.completion.chunk',
          created: 0,
          choices: [
            { index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null },
          ],
        };
        // Final chunk carries finish_reason + usage (with cost) — OpenRouter's shape
        // when usage:{include:true} is set on the request.
        const finalChunk = {
          id,
          provider: 'e2e',
          model,
          object: 'chat.completion.chunk',
          created: 0,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: completionUsage,
        };
        res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
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

  return server;
}
