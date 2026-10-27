'use client';

import React, { useState } from 'react';
import { Button } from '@/retained/components/ui/button';
import { Alert, AlertDescription } from '@/retained/components/ui/alert';
import { Textarea } from '@/retained/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/retained/components/ui/alert-dialog';
import { AlertTriangle, Play, Square, RotateCw, Trash2 } from 'lucide-react';
import { useMCP } from '@/retained/hooks/useMCP';
import type { MCPServerStatus } from '@/retained/types/mcp';
import {
  SettingsGroup,
  SettingsScreen,
  SettingsSection,
} from '@/ui/settings/settings-screen/settings-screen';

const statusLabel: Record<MCPServerStatus, string> = {
  running: 'Running',
  stopped: 'Stopped',
  starting: 'Starting',
  error: 'Error',
  crashed: 'Crashed',
};

const statusClass: Record<MCPServerStatus, string> = {
  running: 'text-green-600',
  stopped: 'text-muted-foreground',
  starting: 'text-blue-500',
  error: 'text-destructive',
  crashed: 'text-destructive',
};

/**
 * Local MCP servers (desktop only): the servers the desktop bridge runs on this computer, and the
 * raw JSON that configures them. Off desktop the screen says so; the nav hides the item there.
 */
export default function LocalMCPSettingsPage() {
  const mcp = useMCP();

  const [configJson, setConfigJson] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [serverToDelete, setServerToDelete] = useState<string | null>(null);

  // Update JSON when config changes
  React.useEffect(() => {
    setConfigJson(JSON.stringify(mcp.config, null, 2));
  }, [mcp.config]);

  const handleSaveJson = async () => {
    try {
      const newConfig = JSON.parse(configJson);
      const result = await mcp.updateConfig(newConfig);
      if (result.success) {
        setJsonError('');
      } else {
        setJsonError(result.error || 'Unknown error');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid JSON';
      setJsonError(errorMessage);
    }
  };

  const confirmDeleteServer = (name: string) => {
    setServerToDelete(name);
    setDeleteDialogOpen(true);
  };

  const handleDeleteServer = async () => {
    if (serverToDelete) {
      await mcp.removeServer(serverToDelete);
      setDeleteDialogOpen(false);
      setServerToDelete(null);
    }
  };

  if (!mcp.isDesktop) {
    return (
      <SettingsScreen
        title="Local MCP servers"
        lede="Run Model Context Protocol servers on your own computer."
      >
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>Desktop only.</strong> Local MCP servers run in the PageSpace desktop app, on the
            computer it is installed on.
          </AlertDescription>
        </Alert>
      </SettingsScreen>
    );
  }

  if (mcp.loading) {
    return <SettingsScreen title="Local MCP servers" lede="Loading..." />;
  }

  const serverNames = Object.keys(mcp.config.mcpServers);

  return (
    <SettingsScreen
      title="Local MCP servers"
      lede="Servers that run on this computer through the desktop app. Agents in any drive you open here can call their tools."
    >
      <div role="note" className="flex items-start gap-2 rounded-xl border border-border bg-muted px-4 py-3 text-sm text-foreground">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-amber-500" aria-hidden="true" />
        <span>
          <strong>MCP servers run commands on your computer.</strong> Only add servers you trust.
        </span>
      </div>

      <SettingsSection title={`Your servers ${serverNames.length}`}>
        <SettingsGroup label="Your servers">
          {serverNames.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              No MCP servers configured. Add servers in the JSON configuration below.
            </p>
          ) : (
            serverNames.map((name) => {
              const serverConfig = mcp.config.mcpServers[name];
              const status = mcp.serverStatuses[name] || {
                status: 'stopped' as MCPServerStatus,
                enabled: true,
                autoStart: false,
                crashCount: 0,
              };

              return (
                <div key={name} className="flex items-start gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-foreground">{name}</span>
                      <span className={`text-xs font-medium ${statusClass[status.status]}`}>
                        {statusLabel[status.status]}
                      </span>
                    </div>
                    <code className="mt-px block truncate font-mono text-xs text-muted-foreground">
                      {serverConfig.command} {serverConfig.args.join(' ')}
                    </code>
                    <div className="mt-px text-xs text-muted-foreground">
                      Auto-start {status.autoStart ? 'on' : 'off'} · Enabled {status.enabled ? 'on' : 'off'}
                      {status.crashCount > 0 ? ` · ${status.crashCount} crashes` : ''}
                    </div>
                    {status.error && <div className="mt-px text-xs text-destructive">Error: {status.error}</div>}
                  </div>
                  <div className="flex flex-none items-center gap-2">
                    {status.status === 'running' ? (
                      <>
                        <Button size="sm" variant="outline" onClick={() => mcp.restartServer(name)}>
                          <RotateCw className="h-4 w-4" />
                          <span className="ml-1">Restart</span>
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => mcp.stopServer(name)}>
                          <Square className="h-4 w-4" />
                          <span className="ml-1">Stop</span>
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => mcp.startServer(name)}
                        disabled={status.status === 'starting'}
                      >
                        <Play className="h-4 w-4" />
                        <span className="ml-1">Start</span>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${name}`}
                      onClick={() => confirmDeleteServer(name)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="JSON configuration"
        description="Same shape as Claude Desktop's mcpServers."
      >
        <Textarea
          id="mcpjson"
          aria-label="MCP servers JSON"
          value={configJson}
          onChange={(e) => {
            setConfigJson(e.target.value);
            setJsonError('');
          }}
          className="min-h-[280px] font-mono text-sm"
          placeholder='{"mcpServers": {}}'
        />
        {jsonError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{jsonError}</AlertDescription>
          </Alert>
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setConfigJson(JSON.stringify(mcp.config, null, 2))}>
            Reset
          </Button>
          <Button onClick={handleSaveJson}>Save configuration</Button>
        </div>
      </SettingsSection>

      {/* Confirmation Dialog for Server Deletion */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Server?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the server &quot;{serverToDelete}&quot;? This action cannot be undone.
              {mcp.serverStatuses[serverToDelete || '']?.status === 'running' && (
                <>
                  <br /><br />
                  <strong>Warning:</strong> This server is currently running and will be stopped.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteServer} className="bg-red-600 hover:bg-red-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsScreen>
  );
}
