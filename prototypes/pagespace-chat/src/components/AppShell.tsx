'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Agent, DriveAgents, ChatMessage, LocalConversation } from '@/lib/types';
import { fetchAgents, fetchConversationMessages } from '@/lib/pagespace';
import Sidebar from './Sidebar';
import ChatArea from './ChatArea';

function makeId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

export default function AppShell() {
  const [drives, setDrives] = useState<DriveAgents[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);

  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const [localConversations, setLocalConversations] = useState<LocalConversation[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const activeConvIdRef = useRef<string | null>(null);
  activeConvIdRef.current = activeConvId;

  useEffect(() => {
    fetchAgents()
      .then(setDrives)
      .catch(console.error)
      .finally(() => setLoadingAgents(false));
  }, []);

  const handleSelectAgent = useCallback(async (agent: Agent, convId?: string) => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
    setSelectedAgent(agent);

    if (convId) {
      setActiveConvId(convId);
      // Check local first
      const local = localConversations.find((c) => c.id === convId);
      if (local) {
        setMessages(local.messages);
        return;
      }
      // Fetch from server
      try {
        const msgs = await fetchConversationMessages(agent.id, convId);
        setMessages(msgs);
      } catch {
        setMessages([]);
      }
    } else {
      setActiveConvId(null);
      setMessages([]);
    }
  }, [localConversations]);

  const handleNewChat = useCallback((agent: Agent) => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
    setSelectedAgent(agent);
    setActiveConvId(null);
    setMessages([]);
  }, []);

  const handleSend = useCallback(async (text: string) => {
    if (!selectedAgent || isStreaming) return;

    // Assign a conversation ID for this session if this is the first message
    let convId = activeConvIdRef.current;
    if (!convId) {
      convId = makeId();
      setActiveConvId(convId);
    }

    const userMsg: ChatMessage = {
      id: makeId(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => {
      const next = [...prev, userMsg];
      // Persist to local conversations
      setLocalConversations((lc) => {
        const existing = lc.find((c) => c.id === convId);
        if (existing) {
          return lc.map((c) => c.id === convId ? { ...c, messages: next } : c);
        }
        return [...lc, {
          id: convId!,
          agentId: selectedAgent.id,
          agentTitle: selectedAgent.title,
          createdAt: new Date().toISOString(),
          messages: next,
        }];
      });
      return next;
    });

    setIsStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;

    const assistantId = makeId();
    setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: '', createdAt: new Date().toISOString() }]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: text }],
          agentId: selectedAgent.id,
          conversation_id: convId,
        }),
        signal: abort.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Request failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice('data:'.length).trim();
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              setMessages((prev) => {
                const next = prev.map((m) =>
                  m.id === assistantId ? { ...m, content: m.content + delta } : m
                );
                // Keep local conversation in sync
                setLocalConversations((lc) =>
                  lc.map((c) =>
                    c.id === convId
                      ? { ...c, messages: next }
                      : c
                  )
                );
                return next;
              });
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: '[Error: request failed]' } : m
          )
        );
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [selectedAgent, isStreaming]);

  return (
    <div className="flex h-screen bg-[#0f0f15] text-white overflow-hidden">
      <Sidebar
        drives={drives}
        loading={loadingAgents}
        selectedAgent={selectedAgent}
        activeConvId={activeConvId}
        localConversations={localConversations}
        onSelectAgent={handleSelectAgent}
        onNewChat={handleNewChat}
      />
      <main className="flex-1 min-w-0">
        <ChatArea
          agent={selectedAgent}
          messages={messages}
          isStreaming={isStreaming}
          onSend={handleSend}
        />
      </main>
    </div>
  );
}
