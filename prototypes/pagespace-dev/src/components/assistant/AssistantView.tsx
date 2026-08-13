"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUp,
  GitBranch,
  History,
  MessageSquare,
  Plus,
  Rocket,
  Send,
  ShieldAlert,
  Sparkles,
  SquareKanban,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { agents } from "@/lib/mock/agents";
import {
  activityFeed,
  conversations,
  type ActivityEvent,
  type AssistantMessage,
} from "@/lib/mock/assistant";
import AgentStatusDot from "@/components/fleet/AgentStatusDot";

let msgSeq = 0;
const mintMessageId = () => `m-${++msgSeq}`;

/** Welcome-state suggestion chips — each is just a pre-typed send. */
const SUGGESTIONS = [
  "What's blocking the fleet right now?",
  "Spawn an agent on T6 once T5 merges",
  "Summarize webhooks-fanout's diff",
];

const EVENT_ICON: Record<ActivityEvent["kind"], React.ElementType> = {
  spawn: Rocket,
  status: GitBranch,
  task: SquareKanban,
  gate: ShieldAlert,
  send: Send,
};

/** Keyword-matched canned replies so the mock conversation feels grounded in the fixtures. */
function mockReply(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("block")) {
    return "Two things are blocked: T6 — retry bookkeeping waits on T5 merging (same files), and fix-auth-refresh is idle at a question — it wants a call between instant-revoke (#2084) and the grace clobber. Answering the agent unblocks the auth epic; T6 unblocks itself when T5 lands.";
  }
  if (t.includes("spawn")) {
    return "Queued (mock): when T5 — after() fan-out moves to Done, I'll spawn a Claude session on atlas / pagespace @ a fresh branch, grounded on T6's spec. The task-to-agent workflow would make this standing behavior instead of a one-off.";
  }
  if (t.includes("diff") || t.includes("webhooks")) {
    return "webhooks-fanout is +245 −38 across 12 files on pu/webhooks-fanout: the after() fan-out in fanout.ts, CHANNEL/AI_AGENT handlers in the dispatch map, and the fan-out test suite. Typecheck green, 214 tests passing. It's converging — the retry bookkeeping (T6) is deliberately left out of this branch.";
  }
  return "Mock assistant — no model behind this yet. In the real app this chat has the whole cockpit as context: the fleet, task boards, diffs, and workflows, with spawn/send/bench as tools.";
}

/**
 * The landing surface. Header mirrors the AI page (AiChatView): a Chat/History
 * TabsList on the left — History is a MIDDLE tab, not a sidebar — with per-tab
 * actions on the right. The Activity button toggles a right-side fleet
 * activity feed panel (the one sidebar-worthy thing here). The chat itself
 * keeps the dashboard grammar: centered welcome + composer until the first
 * message, then a docked conversation.
 */
export default function AssistantView() {
  const [activeTab, setActiveTab] = useState("chat");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("assistant");
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, thinking]);

  const send = useCallback(
    (raw?: string) => {
      const text = (raw ?? input).trim();
      if (!text || thinking) return;
      setInput("");
      setMessages((prev) => [...prev, { id: mintMessageId(), role: "user", text }]);
      setThinking(true);
      window.setTimeout(() => {
        setMessages((prev) => [...prev, { id: mintMessageId(), role: "assistant", text: mockReply(text) }]);
        setThinking(false);
      }, 700);
    },
    [input, thinking],
  );

  const newConversation = () => {
    setMessages([]);
    setInput("");
    setThinking(false);
    setActiveTab("chat");
  };

  const openConversation = (id: string) => {
    const conversation = conversations.find((c) => c.id === id);
    if (!conversation) return;
    setMessages(conversation.messages);
    setThinking(false);
    setActiveTab("chat");
  };

  const empty = messages.length === 0;

  const composer = (
    <div className="w-full max-w-2xl">
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-card px-4 py-3 shadow-[var(--shadow-ambient)] focus-within:border-primary/40">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder={selectedAgent ? `Ask ${selectedAgent.name}...` : "Ask about your fleet..."}
          className="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
        />
        <Button
          size="icon"
          className="size-7 shrink-0 rounded-full"
          aria-label="Send"
          disabled={!input.trim() || thinking}
          onClick={() => send()}
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full min-h-0 flex-col gap-0">
          {/* Header — TabsList left, per-tab actions right (the AiChatView pattern). */}
          <div className="flex items-center justify-between gap-3 border-b border-[var(--separator)] px-4 py-2.5">
            <TabsList>
              <TabsTrigger value="chat" className="gap-1.5">
                <MessageSquare className="size-4" />
                <span className="hidden sm:inline">Chat</span>
              </TabsTrigger>
              <TabsTrigger value="history" className="gap-1.5">
                <History className="size-4" />
                <span className="hidden sm:inline">History</span>
              </TabsTrigger>
            </TabsList>

            <div className="flex items-center gap-1.5">
              {activeTab === "chat" && (
                <>
                  <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                    <SelectTrigger className="h-8 w-44 border-none bg-transparent shadow-none hover:bg-accent/50">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="assistant">
                        <span className="flex items-center gap-2">
                          <Sparkles className="size-3.5 text-primary" />
                          Assistant
                        </span>
                      </SelectItem>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          <span className="flex items-center gap-2 font-mono text-xs">
                            <AgentStatusDot status={agent.status} className="size-1.5" />
                            {agent.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant={activityOpen ? "secondary" : "ghost"}
                    size="icon"
                    className="size-8"
                    title="Fleet activity"
                    aria-pressed={activityOpen}
                    onClick={() => setActivityOpen((open) => !open)}
                  >
                    <Activity className="size-4" />
                  </Button>
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={newConversation}>
                    <Plus className="size-4" />
                    <span className="hidden sm:inline">New</span>
                  </Button>
                </>
              )}
            </div>
          </div>

          <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col outline-none">
            {empty ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6">
                <div className="text-center">
                  <h2 className="text-2xl font-semibold tracking-tight">How can I help you today?</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Tell me what you&apos;re working on — I can watch the fleet, ground agents on tasks, and converge the work.
                  </p>
                </div>
                {composer}
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
                    {messages.map((m) =>
                      m.role === "user" ? (
                        <div key={m.id} className="flex justify-end">
                          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-muted px-4 py-2.5 text-sm">
                            {m.text}
                          </div>
                        </div>
                      ) : (
                        <div key={m.id} className="flex gap-3">
                          <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10">
                            <Sparkles className="size-3.5 text-primary" />
                          </span>
                          <p className="text-sm leading-relaxed">{m.text}</p>
                        </div>
                      ),
                    )}
                    {thinking && (
                      <div className="flex gap-3">
                        <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10">
                          <Sparkles className="size-3.5 text-primary status-pulse" />
                        </span>
                        <p className="text-sm text-muted-foreground">Thinking…</p>
                      </div>
                    )}
                    <div ref={endRef} />
                  </div>
                </div>
                <div className="flex justify-center border-t border-[var(--separator)] px-4 py-3">{composer}</div>
              </>
            )}
          </TabsContent>

          {/* History as a MIDDLE tab, like the AI page — not a sidebar. */}
          <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto outline-none">
            <div className="mx-auto max-w-2xl space-y-2 px-4 py-4">
              {conversations.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => openConversation(c.id)}
                  className="w-full rounded-lg border border-border bg-card p-3 text-left shadow-[var(--shadow-ambient)] transition-colors hover:border-primary/40"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{c.title}</span>
                    <div className="flex-1" />
                    <span className="shrink-0 text-[11px] text-muted-foreground">{c.when}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {c.messages[c.messages.length - 1]?.text}
                  </p>
                  <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                    {c.messages.length} messages
                  </div>
                </button>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* The fleet activity feed — the one sidebar-worthy panel on this surface. */}
      {activityOpen && (
        <aside className="hidden w-80 shrink-0 flex-col border-l border-[var(--separator)] lg:flex">
          <div className="flex items-center gap-2 border-b border-[var(--separator)] px-3 py-2.5">
            <Activity className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Fleet activity</span>
            <div className="flex-1" />
            <button
              type="button"
              aria-label="Close activity"
              onClick={() => setActivityOpen(false)}
              className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <ol className="space-y-3 p-3">
              {activityFeed.map((event) => {
                const Icon = EVENT_ICON[event.kind];
                return (
                  <li key={event.id} className="flex gap-2.5">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted/60">
                      <Icon className="size-3 text-muted-foreground" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs leading-snug">{event.text}</p>
                      <span className="font-mono text-[10px] text-muted-foreground">{event.when} ago</span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </ScrollArea>
        </aside>
      )}
    </div>
  );
}
