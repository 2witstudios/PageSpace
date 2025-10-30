'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
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
  Plus,
  Trash2,
  Book,
  Terminal,
} from 'lucide-react';
import { useMCP } from '@/hooks/useMCP';
import type { MCPServerStatus } from '@/types/mcp';

export default function LocalMCPSettingsPage() {
  const router = useRouter();
  const mcp = useMCP();

  const [configJson, setConfigJson] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newServerCommand, setNewServerCommand] = useState('npx');
  const [newServerArgs, setNewServerArgs] = useState('-y @modelcontextprotocol/server-filesystem');
  const [nameError, setNameError] = useState('');
  const [argsError, setArgsError] = useState('');
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

  const validateServerName = (name: string): boolean => {
    if (!name.trim()) {
      setNameError('Server name is required');
      return false;
    }

    const nameRegex = /^[a-zA-Z0-9_-]+$/;
    if (!nameRegex.test(name)) {
      setNameError('Server name can only contain letters, numbers, hyphens, and underscores');
      return false;
    }

    if (mcp.config.mcpServers[name]) {
      setNameError('A server with this name already exists');
      return false;
    }

    setNameError('');
    return true;
  };

  const validateArgs = (args: string): boolean => {
    if (!args.trim()) {
      setArgsError('Arguments are required');
      return false;
    }

    setArgsError('');
    return true;
  };

  const handleAddServer = async () => {
    const nameValid = validateServerName(newServerName);
    const argsValid = validateArgs(newServerArgs);

    if (!nameValid || !argsValid) {
      return;
    }

    const args = newServerArgs.split(' ').filter(arg => arg.trim());

    const result = await mcp.addServer(newServerName, {
      command: newServerCommand,
      args,
      autoStart: true,
      enabled: true,
    });

    if (result.success) {
      setAddDialogOpen(false);
      setNewServerName('');
      setNewServerArgs('-y @modelcontextprotocol/server-filesystem');
      setNameError('');
      setArgsError('');
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
          <TabsTrigger value="guide">
            <Book className="h-4 w-4 mr-2" />
            Getting Started
          </TabsTrigger>
        </TabsList>

        {/* Servers Tab */}
        <TabsContent value="servers" className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold">Your MCP Servers</h2>
            <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Server
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add MCP Server</DialogTitle>
                  <DialogDescription>
                    Configure a new MCP server to run on your machine.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div>
                    <Label htmlFor="server-name">Server Name</Label>
                    <Input
                      id="server-name"
                      placeholder="filesystem"
                      value={newServerName}
                      onChange={(e) => {
                        setNewServerName(e.target.value);
                        setNameError('');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddServer();
                        }
                      }}
                    />
                    {nameError && (
                      <p className="text-sm text-red-500 mt-1">{nameError}</p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="server-command">Command</Label>
                    <Input
                      id="server-command"
                      placeholder="npx"
                      value={newServerCommand}
                      onChange={(e) => setNewServerCommand(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddServer();
                        }
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor="server-args">Arguments</Label>
                    <Input
                      id="server-args"
                      placeholder="-y @modelcontextprotocol/server-filesystem /path/to/dir"
                      value={newServerArgs}
                      onChange={(e) => {
                        setNewServerArgs(e.target.value);
                        setArgsError('');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddServer();
                        }
                      }}
                    />
                    {argsError && (
                      <p className="text-sm text-red-500 mt-1">{argsError}</p>
                    )}
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleAddServer}>Add Server</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {Object.keys(mcp.config.mcpServers).length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <Server className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No MCP servers configured</h3>
                <p className="text-muted-foreground mb-4">
                  Add your first MCP server to extend AI capabilities
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

        {/* Getting Started Tab */}
        <TabsContent value="guide" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Getting Started with MCP Servers</CardTitle>
              <CardDescription>
                Learn how to configure and use MCP servers with PageSpace
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <h3 className="font-semibold mb-2">What are MCP Servers?</h3>
                <p className="text-sm text-muted-foreground">
                  Model Context Protocol (MCP) servers provide AI models with access to external tools
                  and data sources. Run servers like filesystem access, GitHub integration, database
                  connections, and more.
                </p>
              </div>

              <div>
                <h3 className="font-semibold mb-2">Popular MCP Servers</h3>
                <ul className="space-y-2 text-sm">
                  <li>
                    <strong>Filesystem:</strong> <code className="bg-muted px-2 py-1 rounded">npx -y @modelcontextprotocol/server-filesystem /path/to/directory</code>
                  </li>
                  <li>
                    <strong>GitHub:</strong> <code className="bg-muted px-2 py-1 rounded">npx -y @modelcontextprotocol/server-github</code>
                  </li>
                  <li>
                    <strong>Slack:</strong> <code className="bg-muted px-2 py-1 rounded">npx -y @modelcontextprotocol/server-slack</code>
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="font-semibold mb-2">Configuration Format</h3>
                <p className="text-sm text-muted-foreground mb-2">
                  PageSpace uses the same configuration format as Claude Desktop:
                </p>
                <pre className="bg-muted p-4 rounded text-xs overflow-x-auto">
{`{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Documents"],
      "env": {},
      "autoStart": true,
      "enabled": true
    }
  }
}`}
                </pre>
              </div>

              <div>
                <h3 className="font-semibold mb-2">Environment Variables</h3>
                <p className="text-sm text-muted-foreground">
                  Add environment variables to the <code>env</code> object for API keys and credentials:
                </p>
                <pre className="bg-muted p-4 rounded text-xs overflow-x-auto mt-2">
{`"env": {
  "GITHUB_TOKEN": "ghp_your_token_here",
  "DEBUG": "mcp:*"
}`}
                </pre>
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
