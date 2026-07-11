"use client";

import '@xterm/xterm/css/xterm.css';
import React from 'react';
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
 * Radix `TabsContent` (no `forceMount`) renders only the active tab's body and
 * unmounts it on switch, so opening a Machine page never eagerly fires all four
 * tabs' data fetches / socket connections at once — only the visible tab
 * initializes. Terminal is the default. The export name (`TerminalView`) and
 * `{ pageId }` prop shape are preserved so `CenterPanel.tsx` /
 * `TerminalKeepAliveHost.tsx` need no change.
 */
const TerminalView = ({ pageId }: TerminalViewProps) => {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

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
        <Tabs defaultValue="terminal" className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="border-b border-border px-2 py-1.5">
            <TabsList className="h-auto bg-transparent p-0">
              {TAB_TRIGGERS.map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  // The four labels don't fit a phone-width row, so below `sm` the
                  // triggers are icon-only. `aria-label` carries the name that the
                  // (display:none) label no longer contributes to the accessible
                  // name, and `title` gives a pointer user the same thing.
                  aria-label={label}
                  title={label}
                  className={cn(
                    'gap-1.5 px-2.5 py-1.5 text-muted-foreground sm:px-3',
                    'data-[state=active]:bg-muted data-[state=active]:text-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  <span className="hidden sm:inline">{label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="terminal" className="min-h-0 flex-1 outline-none">
            <TerminalTab machineId={pageId} />
          </TabsContent>
          <TabsContent value="code" className="min-h-0 flex-1 outline-none">
            <CodeTab machineId={pageId} />
          </TabsContent>
          <TabsContent value="diff" className="min-h-0 flex-1 outline-none">
            <DiffTab machineId={pageId} />
          </TabsContent>
          <TabsContent value="settings" className="min-h-0 flex-1 outline-none">
            <SettingsTab machineId={pageId} />
          </TabsContent>
        </Tabs>
      )}
    </motion.div>
  );
};

export default React.memo(TerminalView);
