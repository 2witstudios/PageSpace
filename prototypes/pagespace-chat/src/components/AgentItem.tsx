'use client';

import { useState, useEffect } from 'react';
import type { Agent, Conversation, LocalConversation } from '@/lib/types';
import { fetchConversations } from '@/lib/pagespace';

interface Props {
  agent: Agent;
  isSelected: boolean;
  activeConvId: string | null;
  localConversations: LocalConversation[];
  onSelect: (agent: Agent, convId?: string) => void;
  onNewChat: (agent: Agent) => void;
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function AgentItem({
  agent, isSelected, activeConvId, localConversations, onSelect, onNewChat,
}: Props) {
  const [expanded, setExpanded] = useState(isSelected);
  const [remoteConvs, setRemoteConvs] = useState<Conversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(false);

  useEffect(() => {
    if (isSelected) setExpanded(true);
  }, [isSelected]);

  const toggleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && remoteConvs.length === 0 && !loadingConvs) {
      setLoadingConvs(true);
      try {
        const convs = await fetchConversations(agent.id);
        setRemoteConvs(convs);
      } catch {
        // silently ignore
      } finally {
        setLoadingConvs(false);
      }
    }
  };

  const allLocalConvs = localConversations.slice().reverse();
  const hasHistory = allLocalConvs.length > 0 || remoteConvs.length > 0;

  return (
    <div className="mb-0.5">
      {/* Agent row */}
      <div
        className={`group flex items-center gap-2.5 px-2 py-2 rounded-lg cursor-pointer transition-colors ${
          isSelected && !activeConvId
            ? 'bg-indigo-600/20 text-white'
            : 'hover:bg-white/5 text-gray-400 hover:text-gray-200'
        }`}
        onClick={() => { onSelect(agent); setExpanded(true); }}
      >
        <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 text-xs font-bold ${
          isSelected && !activeConvId ? 'bg-indigo-500/30 text-indigo-300' : 'bg-white/5 text-gray-500'
        }`}>
          {agent.title.charAt(0).toUpperCase()}
        </div>
        <span className="flex-1 text-xs font-medium truncate">{agent.title}</span>

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {/* New chat button */}
          <button
            onClick={(e) => { e.stopPropagation(); onNewChat(agent); }}
            title="New conversation"
            className="w-5 h-5 rounded flex items-center justify-center hover:bg-white/10 text-gray-500 hover:text-gray-300 transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          </button>
          {/* Expand toggle */}
          <button
            onClick={(e) => { e.stopPropagation(); toggleExpand(); }}
            className="w-5 h-5 rounded flex items-center justify-center hover:bg-white/10 text-gray-500 hover:text-gray-300 transition-colors"
          >
            <svg
              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Conversation history */}
      {expanded && hasHistory && (
        <div className="ml-4 pl-2 border-l border-white/5 mt-0.5 space-y-0.5">
          {loadingConvs && (
            <div className="text-xs text-gray-600 px-2 py-1">Loading history…</div>
          )}
          {allLocalConvs.map((conv) => (
            <button
              key={conv.id}
              onClick={() => onSelect(agent, conv.id)}
              className={`w-full text-left px-2 py-1.5 rounded-md text-xs transition-colors ${
                activeConvId === conv.id
                  ? 'bg-indigo-600/20 text-indigo-300'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
              }`}
            >
              <div className="truncate font-medium">
                {conv.messages[0]?.content?.slice(0, 40) || 'New conversation'}
              </div>
              <div className="text-gray-600 mt-0.5">{timeAgo(conv.createdAt)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
