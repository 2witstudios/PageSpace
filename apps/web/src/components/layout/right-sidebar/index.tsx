'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { MessageSquare, History, Settings } from 'lucide-react';
import AssistantChatTab from './ai-assistant/AssistantChatTab';
import AssistantHistoryTab from './ai-assistant/AssistantHistoryTab';
import AssistantSettingsTab from './ai-assistant/AssistantSettingsTab';
import { createClientLogger } from '@/lib/logging/client-logger';

const panelLogger = createClientLogger({ namespace: 'ui', component: 'right-sidebar' });

export default function RightPanel() {
  const pathname = usePathname();
  panelLogger.debug('Evaluating RightPanel pathname', {
    pathname,
    pathnameType: typeof pathname,
  });

  // Treat dashboard and drive root pages the same (no chat tab)
  let isDashboardOrDrive = false;

  // Safely handle pathname that might be null/undefined
  if (pathname && typeof pathname === 'string') {
    try {
      const matchResult = pathname.match(/^\/dashboard\/[^/]+$/);
      panelLogger.debug('RightPanel pathname match evaluated', {
        matchFound: Boolean(matchResult),
      });
      isDashboardOrDrive = pathname === '/dashboard' || !!matchResult;
    } catch (error) {
      panelLogger.error('Failed to evaluate pathname match in RightPanel', {
        error: error instanceof Error ? error : String(error),
      });
      isDashboardOrDrive = false;
    }
  } else {
    panelLogger.warn('RightPanel received null or undefined pathname');
    isDashboardOrDrive = false;
  }

  panelLogger.debug('RightPanel computed dashboard/drive state', {
    isDashboardOrDrive,
  });
  
  // Determine default tab based on context
  const defaultTab = isDashboardOrDrive ? 'history' : 'chat';
  const [activeTab, setActiveTab] = useState<string>(defaultTab);

  // Remember tab state across sessions, but respect context
  useEffect(() => {
    const savedTab = localStorage.getItem('globalAssistantActiveTab');
    
    // If on dashboard or drive root, don't allow 'chat' tab
    if (isDashboardOrDrive && savedTab === 'chat') {
      setActiveTab('history');
    } else if (savedTab && ['chat', 'history', 'settings'].includes(savedTab)) {
      // Only set saved tab if it's valid for current context
      if (!isDashboardOrDrive || savedTab !== 'chat') {
        setActiveTab(savedTab);
      }
    }
  }, [isDashboardOrDrive]);

  // Listen for storage events to update tab when buttons are clicked
  useEffect(() => {
    const handleStorageChange = () => {
      const savedTab = localStorage.getItem('globalAssistantActiveTab');
      if (savedTab && ['history', 'settings'].includes(savedTab)) {
        setActiveTab(savedTab);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    localStorage.setItem('globalAssistantActiveTab', tab);
  };

  return (
    <aside className="hidden sm:flex w-80 border-l bg-sidebar text-sidebar-foreground flex-col h-full">
      {/* Custom Tab Header */}
      <div className="border-b bg-muted/30">
        <div className={isDashboardOrDrive ? "grid grid-cols-2" : "grid grid-cols-3"}>
          {/* Only show Chat tab when not on dashboard or drive root */}
          {!isDashboardOrDrive && (
            <button
              onClick={() => handleTabChange('chat')}
              className={`flex items-center justify-center space-x-1 py-3 text-sm font-medium transition-colors relative
                ${activeTab === 'chat' 
                  ? 'text-foreground bg-background' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
            >
              <MessageSquare className="h-4 w-4" />
              <span className="hidden md:inline">Chat</span>
              {activeTab === 'chat' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
              )}
            </button>
          )}
          
          <button
            onClick={() => handleTabChange('history')}
            className={`flex items-center justify-center space-x-1 py-3 text-sm font-medium transition-colors relative
              ${activeTab === 'history' 
                ? 'text-foreground bg-background' 
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
          >
            <History className="h-4 w-4" />
            <span className="hidden md:inline">History</span>
            {activeTab === 'history' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
            )}
          </button>
          
          <button
            onClick={() => handleTabChange('settings')}
            className={`flex items-center justify-center space-x-1 py-3 text-sm font-medium transition-colors relative
              ${activeTab === 'settings' 
                ? 'text-foreground bg-background' 
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
          >
            <Settings className="h-4 w-4" />
            <span className="hidden md:inline">Settings</span>
            {activeTab === 'settings' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
            )}
          </button>
        </div>
      </div>
      
      {/* Tab Content - Simple conditional rendering */}
      <div className="flex-grow min-h-0 overflow-hidden">
        {activeTab === 'chat' && <AssistantChatTab />}
        {activeTab === 'history' && <AssistantHistoryTab />}
        {activeTab === 'settings' && <AssistantSettingsTab />}
      </div>
    </aside>
  );
}