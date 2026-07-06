"use client";

import '@xterm/xterm/css/xterm.css';
import React, { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { motion } from 'motion/react';
import { useSocket } from '@/hooks/useSocket';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

interface TerminalViewProps {
  pageId: string;
}

const XtermTerminal = dynamic(() => import('./XtermTerminal'), { ssr: false });
const TerminalWorkspace = dynamic(() => import('./workspace/TerminalWorkspace'), { ssr: false });

const SESSION_FLAG_KEY = (pageId: string) => `terminal-session:${pageId}`;

const TerminalView = ({ pageId }: TerminalViewProps) => {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className="h-full flex flex-col relative bg-black"
    >
      {!isAdmin && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 px-4 py-2">
          <p className="text-sm text-yellow-800 dark:text-yellow-200 text-center">
            Terminal access requires administrator privileges
          </p>
        </div>
      )}

      {isAdmin && (
        <Tabs defaultValue="workspace" className="flex-1 min-h-0 flex flex-col gap-0">
          <TabsList className="w-fit rounded-none border-b border-white/10 bg-black">
            <TabsTrigger value="workspace">Workspace</TabsTrigger>
            <TabsTrigger value="shell">Machine Shell</TabsTrigger>
          </TabsList>
          <TabsContent value="workspace" className="flex-1 min-h-0 m-0">
            <TerminalWorkspace terminalId={pageId} />
          </TabsContent>
          <TabsContent value="shell" className="flex-1 min-h-0 m-0">
            <MachineShell pageId={pageId} />
          </TabsContent>
        </Tabs>
      )}
    </motion.div>
  );
};

/** The Machine's own persistent shell — a direct root session on the Machine itself, separate from any branch-terminal's Sprite. */
function MachineShell({ pageId }: { pageId: string }) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isReconnect = typeof sessionStorage !== 'undefined' && !!sessionStorage.getItem(SESSION_FLAG_KEY(pageId));
  const socket = useSocket();

  const handleReady = useCallback(() => {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(SESSION_FLAG_KEY(pageId), '1');
    }
    setConnected(true);
  }, [pageId]);
  const handleError = useCallback((message: string) => {
    setError(message);
    toast.error(`Terminal error: ${message}`);
  }, []);

  return (
    <div className="h-full min-h-0 relative bg-black">
      {socket && (
        <XtermTerminal
          socket={socket}
          sessionId={`terminal:${pageId}`}
          connectPayload={{ pageId }}
          onReady={handleReady}
          onError={handleError}
        />
      )}

      {!connected && (
        <div className="absolute inset-0 bg-black flex items-center justify-center">
          {error ? (
            <span className="text-sm text-red-400">{error}</span>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-green-400">{isReconnect ? 'Reconnecting to shell...' : 'Connecting to shell...'}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default React.memo(TerminalView);
