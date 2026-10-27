'use client';

import { useState } from 'react';
import type { Agent, DriveAgents, LocalConversation } from '@/lib/types';
import AgentItem from './AgentItem';

interface Props {
  drives: DriveAgents[];
  loading: boolean;
  selectedAgent: Agent | null;
  activeConvId: string | null;
  localConversations: LocalConversation[];
  onSelectAgent: (agent: Agent, convId?: string) => void;
  onNewChat: (agent: Agent) => void;
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-4 py-4 border-b border-white/5">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
          <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" />
        </svg>
      </div>
      <div>
        <div className="text-sm font-semibold text-white">PageSpace</div>
        <div className="text-xs text-gray-500">AI Agents</div>
      </div>
    </div>
  );
}

export default function Sidebar({
  drives, loading, selectedAgent, activeConvId, localConversations, onSelectAgent, onNewChat,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleDrive = (id: string) => {
    setCollapsed((p) => ({ ...p, [id]: !p[id] }));
  };

  const totalAgents = drives.reduce((sum, d) => sum + d.agents.length, 0);

  return (
    <aside className="w-64 flex-shrink-0 bg-[#0d0d12] border-r border-white/5 flex flex-col h-full">
      <Logo />

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {loading && (
          <div className="space-y-2 px-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-8 bg-white/5 rounded-lg animate-pulse" />
            ))}
          </div>
        )}

        {!loading && drives.length === 0 && (
          <div className="px-2 text-xs text-gray-600 mt-4 text-center">
            No agents found.<br />Create an AI_CHAT page in PageSpace.
          </div>
        )}

        {drives.map((drive) => {
          const isCollapsed = collapsed[drive.driveId];
          return (
            <div key={drive.driveId} className="mb-4">
              {/* Drive header */}
              <button
                onClick={() => toggleDrive(drive.driveId)}
                className="w-full flex items-center gap-1.5 px-2 py-1 text-xs font-semibold text-gray-500 uppercase tracking-widest hover:text-gray-400 transition-colors"
              >
                <svg
                  width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                  className={`flex-shrink-0 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                >
                  <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="truncate">{drive.driveName}</span>
                <span className="ml-auto text-gray-700 font-normal normal-case tracking-normal">
                  {drive.agents.length}
                </span>
              </button>

              {!isCollapsed && (
                <div className="mt-1">
                  {drive.agents.map((agent) => (
                    <AgentItem
                      key={agent.id}
                      agent={agent}
                      isSelected={selectedAgent?.id === agent.id}
                      activeConvId={selectedAgent?.id === agent.id ? activeConvId : null}
                      localConversations={localConversations.filter((c) => c.agentId === agent.id)}
                      onSelect={onSelectAgent}
                      onNewChat={onNewChat}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-white/5 text-xs text-gray-700">
        {loading ? 'Loading…' : `${totalAgents} agent${totalAgents !== 1 ? 's' : ''} across ${drives.length} drive${drives.length !== 1 ? 's' : ''}`}
      </div>
    </aside>
  );
}
