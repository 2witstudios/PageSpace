'use client';

import { useState, useRef, FormEvent } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatShellProps {
  activeConvId?: string;
}

export function ChatShell({ activeConvId }: ChatShellProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;

    const userMessage: Message = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setStreaming(true);

    const abortController = new AbortController();
    abortRef.current = abortController;

    // In thread mode, send only the latest user message — server loads history.
    // In openai mode, send the full accumulated history.
    const history = activeConvId ? [userMessage] : [...messages, userMessage];

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history,
          ...(activeConvId ? { conversation_id: activeConvId } : {}),
        }),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Request failed: ${response.status}`);
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

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
                const next = [...prev];
                next[next.length - 1] = {
                  role: 'assistant',
                  content: (next[next.length - 1]?.content ?? '') + delta,
                };
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
        setMessages((prev) => [...prev, { role: 'assistant', content: '[Error: request failed]' }]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', maxWidth: 720, margin: '0 auto', padding: '1rem' }}>
      {activeConvId && (
        <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Thread: {activeConvId}</div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', background: m.role === 'user' ? '#0070f3' : '#f0f0f0', color: m.role === 'user' ? '#fff' : '#000', padding: '0.5rem 0.75rem', borderRadius: 8, maxWidth: '80%', whiteSpace: 'pre-wrap' }}>
            {m.content}
          </div>
        ))}
        {streaming && messages[messages.length - 1]?.role !== 'assistant' && (
          <div style={{ alignSelf: 'flex-start', color: '#888', fontStyle: 'italic' }}>…</div>
        )}
      </div>
      <form onSubmit={submit} style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message…"
          disabled={streaming}
          style={{ flex: 1, padding: '0.5rem', borderRadius: 4, border: '1px solid #ccc' }}
        />
        <button type="submit" disabled={streaming || !input.trim()} style={{ padding: '0.5rem 1rem' }}>
          {streaming ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
