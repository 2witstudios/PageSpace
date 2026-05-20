'use client';

import { useEffect, useRef } from 'react';
import type { ChatMessage, Agent } from '@/lib/types';
import Message from './Message';
import MessageInput from './MessageInput';

interface Props {
  agent: Agent | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  onSend: (text: string) => void;
}

function EmptyState({ agent }: { agent: Agent | null }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 text-center px-8">
      {agent ? (
        <>
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-xl">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" />
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-semibold text-white mb-2">{agent.title}</h2>
            <p className="text-gray-500 text-sm max-w-xs">
              Start a conversation. Your messages are streamed in real-time.
            </p>
            {agent.aiModel && (
              <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-indigo-400 bg-indigo-400/10 rounded-full px-3 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                {agent.aiModel}
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="1.5">
              <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 0 1-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-400 mb-1">No agent selected</h2>
            <p className="text-gray-600 text-sm">Choose an agent from the sidebar to begin.</p>
          </div>
        </>
      )}
    </div>
  );
}

export default function ChatArea({ agent, messages, isStreaming, onSend }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const hasMessages = messages.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      {agent && (
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-white/5 bg-[#0f0f15]/80 backdrop-blur-sm flex-shrink-0">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" />
            </svg>
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-white truncate">{agent.title}</h1>
            {agent.aiModel && (
              <p className="text-xs text-gray-500 truncate">{agent.aiModel}</p>
            )}
          </div>
          {isStreaming && (
            <div className="ml-auto flex items-center gap-1.5 text-xs text-indigo-400">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
              Generating…
            </div>
          )}
        </div>
      )}

      {/* Message list */}
      <div ref={listRef} className="flex-1 overflow-y-auto py-4">
        {!hasMessages ? (
          <EmptyState agent={agent} />
        ) : (
          <>
            {messages.map((msg, i) => (
              <Message
                key={msg.id}
                message={msg}
                isStreaming={isStreaming && i === messages.length - 1 && msg.role === 'assistant'}
              />
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Input */}
      <MessageInput
        onSend={onSend}
        disabled={isStreaming || !agent}
        agentTitle={agent?.title}
      />
    </div>
  );
}
