import type { Plugin } from "vite";

/*
 * Dev-server chat proxy for the PUBLIC (customer) chat.
 *
 * The completions endpoint requires *edit* on the agent page — which also means
 * the ability to reconfigure the agent (enable bash, change the prompt) and edit
 * the drive. So a customer must never hold that token. This middleware holds the
 * token server-side (never shipped to the browser) and forwards ONLY the
 * chat-completions call, PINNED to the public read-only agent. A customer can
 * chat; they cannot reach the config endpoint, the SDK writes, or the owner
 * agent.
 *
 * In production this is a serverless function, and this is where rate limiting
 * lives (the endpoint has none natively).
 */
export interface ChatProxyOptions {
  /** Edit-capable token, held server-side only. Never shipped to the browser. */
  token?: string;
  /** The public read-only agent the proxy is pinned to. */
  publicAgentId?: string;
  apiUrl?: string;
}

export function chatProxy(opts: ChatProxyOptions): Plugin {
  return {
    name: "pagespace-public-chat-proxy",
    configureServer(server) {
      server.middlewares.use("/proxy/chat", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method not allowed");
          return;
        }

        const token = opts.token;
        const publicAgentId = opts.publicAgentId;
        const apiUrl = (opts.apiUrl ?? "https://pagespace.ai").replace(/\/+$/, "");

        if (!token || !publicAgentId) {
          res.statusCode = 500;
          res.end("Chat proxy is not configured (PAGESPACE_PROXY_TOKEN / PAGESPACE_PUBLIC_AGENT_ID).");
          return;
        }

        // Cap the buffered body: a chat request is small, and an unbounded POST
        // would let a caller exhaust memory (this proxy has no rate limiting).
        const MAX_BODY_BYTES = 1_000_000;
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_BODY_BYTES) {
            res.statusCode = 413;
            res.end("Payload too large");
            return;
          }
          chunks.push(chunk as Buffer);
        }
        let messages: unknown = [];
        try {
          messages = JSON.parse(Buffer.concat(chunks).toString() || "{}").messages ?? [];
        } catch {
          res.statusCode = 400;
          res.end("Invalid JSON body");
          return;
        }

        // connect-style middleware does not await/catch an async handler's
        // rejection, so an upstream network/stream failure would otherwise leave
        // the client's request hanging with no response. Own the error path.
        try {
          const upstream = await fetch(`${apiUrl}/api/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            // The agent is PINNED here — the client cannot choose it.
            body: JSON.stringify({ model: `ps-agent://${publicAgentId}`, stream: true, messages }),
          });

          res.statusCode = upstream.status;
          res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");

          if (!upstream.body) {
            res.end();
            return;
          }
          const reader = upstream.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          res.end();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (res.headersSent) {
            // Stream already started; we can't change the status, just stop.
            res.end();
          } else {
            res.statusCode = 502;
            res.end(`Upstream chat request failed: ${message}`);
          }
        }
      });
    },
  };
}
