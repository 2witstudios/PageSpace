'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  ArrowLeft,
  Play,
  Square,
  RotateCw,
  AlertTriangle,
  Server,
  CheckCircle2,
  XCircle,
  Loader2,
  Trash2,
  Terminal,
} from 'lucide-react';
import { useMCP } from '@/hooks/useMCP';
import type { MCPServerStatus } from '@/types/mcp';

export default function LocalMCPSettingsPage() {
  const router = useRouter();
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

  const getStatusIcon = (status: MCPServerStatus) => {
    switch (status) {
      case 'running':
        return <CheckCircle2 className="h-5 w-5 text-green-500" />;
      case 'stopped':
        return <Square className="h-5 w-5 text-gray-400" />;
      case 'starting':
        return <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />;
      case 'error':
      case 'crashed':
        return <XCircle className="h-5 w-5 text-red-500" />;
    }
  };

  const getStatusBadge = (status: MCPServerStatus) => {
    const variants: Record<MCPServerStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
      running: 'default',
      stopped: 'secondary',
      starting: 'outline',
      error: 'destructive',
      crashed: 'destructive',
    };
    return (
      <Badge variant={variants[status]}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    );
  };

  // Show desktop-only message if not on desktop
  if (!mcp.isDesktop) {
    return (
      <div className="container mx-auto py-10 px-10">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>

        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>Desktop Only Feature</strong>
            <p className="mt-2">
              Local MCP Servers are only available in the PageSpace Desktop app.
              This feature allows you to run MCP servers on your local machine, similar to
              Claude Desktop, Cursor, and Roo Code.
            </p>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (mcp.loading) {
    return (
      <div className="container mx-auto py-10 px-10">
        <div className="flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-10 space-y-8 px-10">
      {/* Header */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold mb-2">Local MCP Servers</h1>
        <p className="text-muted-foreground">
          Run Model Context Protocol servers on your local machine to extend AI capabilities
          with custom tools and integrations.
        </p>
      </div>

      {/* Security Warning */}
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <strong>Security Notice:</strong> MCP servers execute commands on your computer.
          Only use servers from trusted sources. Review configuration carefully before starting servers.
        </AlertDescription>
      </Alert>

      {/* Tabs: Server Management vs JSON Config */}
      <Tabs defaultValue="servers" className="w-full">
        <TabsList>
          <TabsTrigger value="servers">
            <Server className="h-4 w-4 mr-2" />
            Servers
          </TabsTrigger>
          <TabsTrigger value="config">
            <Terminal className="h-4 w-4 mr-2" />
            Configuration
          </TabsTrigger>
        </TabsList>

        {/* Servers Tab */}
        <TabsContent value="servers" className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold">Your MCP Servers</h2>
          </div>

          {Object.keys(mcp.config.mcpServers).length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <Server className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No MCP servers configured</h3>
                <p className="text-muted-foreground mb-4">
                  Add servers by editing the configuration in the Configuration tab
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {Object.entries(mcp.config.mcpServers).map(([name, serverConfig]) => {
                const status = mcp.serverStatuses[name] || {
                  status: 'stopped' as MCPServerStatus,
                  enabled: true,
                  autoStart: false,
                  crashCount: 0,
                };

                return (
                  <Card key={name}>
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          {getStatusIcon(status.status)}
                          <div>
                            <CardTitle className="text-lg">{name}</CardTitle>
                            <CardDescription className="font-mono text-xs mt-1">
                              {serverConfig.command} {serverConfig.args.join(' ')}
                            </CardDescription>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {getStatusBadge(status.status)}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-muted-foreground space-y-1">
                          {status.error && (
                            <div className="text-red-500">Error: {status.error}</div>
                          )}
                          {status.crashCount > 0 && (
                            <div>Crashes: {status.crashCount}</div>
                          )}
                          <div className="flex gap-2">
                            <span>Auto-start: {status.autoStart ? 'Yes' : 'No'}</span>
                            <span>•</span>
                            <span>Enabled: {status.enabled ? 'Yes' : 'No'}</span>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          {status.status === 'running' ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => mcp.restartServer(name)}
                              >
                                <RotateCw className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => mcp.stopServer(name)}
                              >
                                <Square className="h-4 w-4" />
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
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => confirmDeleteServer(name)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* Configuration Tab */}
        <TabsContent value="config" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>JSON Configuration</CardTitle>
              <CardDescription>
                Edit the raw JSON configuration. Compatible with Claude Desktop config format.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                value={configJson}
                onChange={(e) => {
                  setConfigJson(e.target.value);
                  setJsonError('');
                }}
                className="font-mono text-sm min-h-[400px]"
                placeholder='{"mcpServers": {}}'
              />
              {jsonError && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{jsonError}</AlertDescription>
                </Alert>
              )}
              <div className="flex gap-2">
                <Button onClick={handleSaveJson}>Save Configuration</Button>
                <Button variant="outline" onClick={() => setConfigJson(JSON.stringify(mcp.config, null, 2))}>
                  Reset
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>

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
    </div>
  );
}
