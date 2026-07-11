"use client";

import '@xterm/xterm/css/xterm.css';
import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Code2, GitCompare, Settings, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import TerminalTab from './tabs/TerminalTab';
import CodeTab from './tabs/CodeTab';
import DiffTab from './tabs/DiffTab';
import SettingsTab from './tabs/SettingsTab';

interface TerminalViewProps {
  pageId: string;
}

type MachineTabValue = 'terminal' | 'code' | 'diff' | 'settings';

const TAB_TRIGGERS: { value: MachineTabValue; label: string; icon: React.ElementType }[] = [
  { value: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { value: 'code', label: 'Code', icon: Code2 },
  { value: 'diff', label: 'Diff', icon: GitCompare },
  { value: 'settings', label: 'Settings', icon: Settings },
];

/**
 * The Machine page's 4-tab command center (Terminal / Code / Diff / Settings).
 *
 * `pageId` IS the Machine id, so it's threaded down to every tab as `machineId`.
 * Each tab's body is mounted only while it is the active tab — switching tabs
 * unmounts the previous one — so opening a Machine page never eagerly fires all
 * four tabs' data fetches / socket connections at once; only the visible tab
 * initializes. Terminal is the default. The export name (`TerminalView`) and
 * `{ pageId }` prop shape are preserved so `CenterPanel.tsx` /
 * `TerminalKeepAliveHost.tsx` need no change.
 */
const TerminalView = ({ pageId }: TerminalViewProps) => {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [activeTab, setActiveTab] = useState<MachineTabValue>('terminal');

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className="relative flex h-full flex-col bg-background"
    >
      {!isAdmin && (
        <div className="border-b border-yellow-200 bg-yellow-50 px-4 py-2 dark:border-yellow-800 dark:bg-yellow-900/20">
          <p className="text-center text-sm text-yellow-800 dark:text-yellow-200">
            Terminal access requires administrator privileges
          </p>
        </div>
      )}

      {isAdmin && (
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as MachineTabValue)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="border-b border-border px-2 py-1.5">
            <TabsList className="h-auto bg-transparent p-0">
              {TAB_TRIGGERS.map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className={cn(
                    'gap-1.5 px-3 py-1.5 text-muted-foreground',
                    'data-[state=active]:bg-muted data-[state=active]:text-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* Each body is gated on the active tab so it mounts lazily and
              unmounts on switch — no eager 4x fetch/socket init on page load. */}
          <TabsContent value="terminal" className="min-h-0 flex-1 outline-none">
            {activeTab === 'terminal' && <TerminalTab machineId={pageId} />}
          </TabsContent>
          <TabsContent value="code" className="min-h-0 flex-1 outline-none">
            {activeTab === 'code' && <CodeTab machineId={pageId} />}
          </TabsContent>
          <TabsContent value="diff" className="min-h-0 flex-1 outline-none">
            {activeTab === 'diff' && <DiffTab machineId={pageId} />}
          </TabsContent>
          <TabsContent value="settings" className="min-h-0 flex-1 outline-none">
            {activeTab === 'settings' && <SettingsTab machineId={pageId} />}
          </TabsContent>
        </Tabs>
      )}
    </motion.div>
  );
};

export default React.memo(TerminalView);
