"use client";

import '@xterm/xterm/css/xterm.css';
import React from 'react';
import dynamic from 'next/dynamic';
import { motion } from 'motion/react';
import { useAuth } from '@/hooks/useAuth';

interface TerminalViewProps {
  pageId: string;
}

const TerminalWorkspace = dynamic(() => import('./workspace/TerminalWorkspace'), { ssr: false });

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
        <div className="flex-1 min-h-0">
          <TerminalWorkspace machineId={pageId} />
        </div>
      )}
    </motion.div>
  );
};

export default React.memo(TerminalView);
