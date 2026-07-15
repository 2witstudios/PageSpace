import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Bot, Loader2, Sparkles } from "lucide-react";
import { Button } from "./ui";

/*
 * The chat surface. It streams from a PageSpace agent over the OpenAI-compatible
 * completions endpoint (deliberately NOT the SDK — the SDK's agent method is
 * single-shot; streaming lives on the endpoint). Two wirings:
 *  - "proxy": the public/customer path. Posts to the dev-server proxy, which
 *    holds the token and pins the public read-only agent. The customer holds no
 *    edit key, so they can chat but can't reconfigure the agent or edit anything.
 *  - "direct": the owner path. Posts straight to the endpoint with the owner's
 *    own edit token and the owner (write-capable) agent.
 */

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type ChatConfig =
  | { kind: "proxy" }
  | { kind: "direct"; apiUrl: string; token: string; agentId: string | null };

interface AskViewProps {
  chat: ChatConfig;
  botName: string;
  suggestions?: string[];
}

const DEFAULT_SUGGESTIONS = [
  "How do I mint a drive-scoped key?",
  "How do I call an agent from my own code?",
  "What page types can I create with the CLI?",
];

export function AskView({ chat, botName, suggestions = DEFAULT_SUGGESTIONS }: AskViewProps) {
  const ready = chat.kind === "proxy" || !!chat.agentId;
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Streaming can outlive the mount (switching tabs unmounts this view). Track
  // liveness and hold the in-flight request so we can stop writing state and
  // abort the fetch on unmount instead of leaking a background read loop.
  const aliveRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Re-set on mount so StrictMode's dev remount (mount → cleanup → mount)
    // doesn't leave the ref stuck false and silently break sending.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, streaming]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || streaming || !ready) return;
    setError(null);
    setInput("");

    const history: ChatTurn[] = [...turns, { role: "user", content: question }];
    setTurns([...history, { role: "assistant", content: "" }]);
    setStreaming(true);

    const messages = history.map((t) => ({ role: t.role, content: t.content }));
    const request =
      chat.kind === "proxy"
        ? {
            url: "/proxy/chat",
            headers: { "Content-Type": "application/json" } as Record<string, string>,
            body: JSON.stringify({ messages }),
          }
        : {
            url: `${chat.apiUrl.replace(/\/+$/, "")}/api/v1/chat/completions`,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${chat.token}` },
            body: JSON.stringify({ model: `ps-agent://${chat.agentId}`, stream: true, messages }),
          };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Chat failed (${res.status}). ${detail.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done || !aliveRef.current) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const line = event.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const chunk = JSON.parse(data);
            const delta: string = chunk.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              setTurns((prev) => {
                const next = [...prev];
                next[next.length - 1] = {
                  role: "assistant",
                  content: next[next.length - 1].content + delta,
                };
                return next;
              });
            }
          } catch {
            /* ignore keep-alive / non-JSON frames */
          }
        }
      }
    } catch (e) {
      // An abort (unmount) or a write after unmount is not a user-facing error.
      if (!aliveRef.current || (e instanceof DOMException && e.name === "AbortError")) return;
      setError(e instanceof Error ? e.message : String(e));
      setTurns((prev) => prev.slice(0, -1)); // drop the empty assistant turn
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (aliveRef.current) setStreaming(false);
    }
  };

  const empty = turns.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end px-4 py-6">
          {empty ? (
            <div className="flex flex-col items-center gap-6 py-20 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Sparkles className="size-7" />
              </div>
              <div className="space-y-1.5">
                <h2 className="text-2xl font-semibold tracking-tight">{botName}</h2>
                <p className="text-muted-foreground text-sm">
                  Ask anything. Answers come straight from this drive&rsquo;s documentation.
                </p>
              </div>
              <div className="flex w-full max-w-md flex-col gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    disabled={!ready}
                    className="rounded-lg border border-border bg-card px-4 py-3 text-left text-sm shadow-xs transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {turns.map((turn, i) =>
                turn.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] rounded-lg bg-secondary px-4 py-3 text-sm text-secondary-foreground">
                      {turn.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex gap-3">
                    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Bot className="size-4" />
                    </div>
                    <div className="prose-doc min-w-0 flex-1 text-sm">
                      {turn.content ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.content}</ReactMarkdown>
                      ) : (
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      )}
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
          {error && (
            <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border bg-background/80 px-4 py-3 backdrop-blur">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm focus-within:ring-ring/40 focus-within:ring-2"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder={ready ? "Ask the support bot…" : "No agent configured for this drive"}
            disabled={!ready}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button type="submit" size="icon" disabled={streaming || !input.trim() || !ready} className="rounded-xl">
            {streaming ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </form>
        <p className="mx-auto mt-1.5 max-w-3xl text-center text-xs text-muted-foreground">
          Powered by a PageSpace agent over the OpenAI-compatible endpoint.
        </p>
      </div>
    </div>
  );
}
