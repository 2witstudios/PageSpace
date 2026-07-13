"use client";

import '@xterm/xterm/css/xterm.css';
import React from 'react';
import { motion } from 'motion/react';
import { FolderTree, GitCompare, Settings, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import {
  useMachineTabStore,
  DEFAULT_MACHINE_TAB,
  type MachineTabValue,
} from '@/stores/machine-workspace/useMachineTabStore';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import TerminalTab from './tabs/TerminalTab';
import FilesTab from './tabs/FilesTab';
import DiffTab from './tabs/DiffTab';
import SettingsTab from './tabs/SettingsTab';

interface MachineViewProps {
  pageId: string;
  /** See `MachineKeepAliveHost`'s doc — set only inside the Development surface, where the Terminal tab's own tree would be redundant with `DevelopmentSidebar`'s. */
  embedded?: boolean;
}

// The tab's stored value/id stays `'code'` — it's the key `useMachineTabStore`
// persists under and the Development sidebar reads to land a session on this
// tab, so renaming it would ripple into that surface. Only the label, icon,
// and component are reframed here: this tab VIEWS a checkout's files, it
// doesn't edit code.
const TAB_TRIGGERS: { value: MachineTabValue; label: string; icon: React.ElementType }[] = [
  { value: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { value: 'code', label: 'Files', icon: FolderTree },
  { value: 'diff', label: 'Diff', icon: GitCompare },
  { value: 'settings', label: 'Settings', icon: Settings },
];

/**
 * The Machine page's 4-tab command center (Terminal / Files / Diff / Settings).
 *
 * `pageId` IS the Machine id, so it's threaded down to every tab as `machineId`.
 * Radix `TabsContent` (no `forceMount`) renders only the active tab's body and
 * unmounts it on switch, so opening a Machine page never eagerly fires all four
 * tabs' data fetches / socket connections at once — only the visible tab
 * initializes. Terminal is the default. The export name (`MachineView`) and
 * `{ pageId }` prop shape are preserved so `CenterPanel.tsx` /
 * `MachineKeepAliveHost.tsx` need no change.
 *
 * The active tab is held in `useMachineTabStore` rather than by Radix, so that
 * "show me this machine's terminal" is something another surface can ask for.
 * The Development sidebar needs it: only the Terminal tab mounts a machine's
 * workspace, so a session clicked on a machine parked on Files/Diff/Settings had
 * nowhere to land. Behaviour is otherwise unchanged — a machine with no stored
 * tab shows Terminal, as before.
 */
const MachineView = ({ pageId, embedded = false }: MachineViewProps) => {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const activeTab = useMachineTabStore((state) => state.tabs[pageId] ?? DEFAULT_MACHINE_TAB);
  const setTab = useMachineTabStore((state) => state.setTab);

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
            Machine access requires administrator privileges
          </p>
        </div>
      )}

      {isAdmin && (
        <Tabs
          value={activeTab}
          onValueChange={(value) => setTab(pageId, value as MachineTabValue)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
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
            <TerminalTab machineId={pageId} embedded={embedded} />
          </TabsContent>
          <TabsContent value="code" className="min-h-0 flex-1 outline-none">
            <FilesTab machineId={pageId} />
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

export default React.memo(MachineView);
