'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
  Alert,
  AlertDescription,
} from '@/components/ui/alert';
import { Trash2, Copy, Plus, Eye, EyeOff, Key, Terminal, Check, Download, AlertTriangle, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { useRouter } from 'next/navigation';

interface MCPToken {
  id: string;
  name: string;
  lastUsed: string | null;
  createdAt: string;
}

interface NewToken extends MCPToken {
  token: string;
}

export default function MCPSettingsView() {
  const router = useRouter();
  const [tokens, setTokens] = useState<MCPToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [newToken, setNewToken] = useState<NewToken | null>(null);
  const [showNewToken, setShowNewToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [selectedToken, setSelectedToken] = useState('');
  const [tokenMap, setTokenMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    loadTokens();
  }, []);

  const loadTokens = async () => {
    try {
      const response = await fetch('/api/auth/mcp-tokens');
      if (response.ok) {
        const tokenList = await response.json();
        setTokens(tokenList);
      } else {
        throw new Error('Failed to load tokens');
      }
    } catch (error) {
      console.error('Error loading MCP tokens:', error);
      toast.error('Failed to load MCP tokens');
    } finally {
      setLoading(false);
    }
  };

  const createToken = async () => {
    if (!newTokenName.trim()) {
      toast.error('Please enter a name for the token');
      return;
    }

    setCreating(true);
    try {
      const response = await fetch('/api/auth/mcp-tokens', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: newTokenName.trim() }),
      });

      if (response.ok) {
        const token = await response.json();
        setNewToken(token);
        setTokens(prev => [token, ...prev]);
        // Store the actual token value for the newly created token
        if (token.token) {
          setTokenMap(prev => new Map(prev).set(token.id, token.token));
          setSelectedToken(token.token);
        }
        setNewTokenName('');
        setCreateDialogOpen(false);
        setShowNewToken(true);
        toast.success('MCP token created successfully');
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create token');
      }
    } catch (error) {
      console.error('Error creating MCP token:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to create MCP token');
    } finally {
      setCreating(false);
    }
  };

  const deleteToken = async (tokenId: string) => {
    try {
      const response = await fetch(`/api/auth/mcp-tokens/${tokenId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        setTokens(prev => prev.filter(token => token.id !== tokenId));
        toast.success('Token deleted successfully');
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete token');
      }
    } catch (error) {
      console.error('Error deleting MCP token:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete token');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Token copied to clipboard');
  };



  const generateConfig = () => {
    const token = selectedToken || '<YOUR_PAGESPACE_MCP_TOKEN_HERE>';
    const config = {
      mcpServers: {
        "pagespace": {
          command: "npx",
          args: ["-y", "pagespace-mcp@latest"],
          env: {
            PAGESPACE_API_URL: "https://www.pagespace.ai",
            PAGESPACE_AUTH_TOKEN: token
          }
        }
      }
    };
    
    return JSON.stringify(config, null, 2);
  };

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(generateConfig());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Configuration copied to clipboard");
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto py-10">
        <h1 className="text-3xl font-bold mb-6">MCP Integration</h1>
        <p className="mb-8 text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-10 space-y-10 px-10">
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
        <h1 className="text-3xl font-bold mb-6">MCP Integration</h1>
        <p className="mb-8 text-muted-foreground">
          Create and manage MCP (Model Context Protocol) tokens for Claude Code and Claude Desktop integration.
          These tokens allow external tools to read and edit your documents.
        </p>
      </div>

      {/* New Token Display */}
      {newToken && (
        <Card className="border-green-600 dark:border-green-400 bg-green-50 dark:bg-green-950/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-green-800 dark:text-green-400 text-lg">Token Created!</CardTitle>
            <CardDescription className="text-green-700 dark:text-green-300">
              Save this token now - it won&apos;t be shown again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div>
                <Label className="text-sm font-medium">Token Name</Label>
                <p className="text-sm">{newToken.name}</p>
              </div>
              <div>
                <Label className="text-sm font-medium">Token Value</Label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="flex-1 p-2 bg-white dark:bg-gray-900 border dark:border-gray-700 rounded text-sm font-mono text-black dark:text-white">
                    {showNewToken ? newToken.token : '•'.repeat(48)}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowNewToken(!showNewToken)}
                  >
                    {showNewToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(newToken.token)}
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setNewToken(null);
                  setShowNewToken(false);
                }}
              >
                I&apos;ve saved this token
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Token Management */}
      <section>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-semibold">Your Tokens</h2>
          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Create Token
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New MCP Token</DialogTitle>
                <DialogDescription>
                  Give your token a descriptive name to help you identify it later.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div>
                  <Label htmlFor="token-name">Token Name</Label>
                  <Input
                    id="token-name"
                    placeholder="e.g., Claude Desktop - MacBook"
                    value={newTokenName}
                    onChange={(e) => setNewTokenName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        createToken();
                      }
                    }}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={createToken} disabled={creating}>
                  {creating ? "Creating..." : "Create Token"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {tokens.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <Key className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No MCP tokens</h3>
              <p className="text-muted-foreground mb-4">
                Create your first token to connect Claude to your documents
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {tokens.map((token) => (
              <Card key={token.id} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h4 className="font-medium">{token.name}</h4>
                      <Badge variant="secondary" className="text-xs">
                        {token.lastUsed ? 'Active' : 'Never Used'}
                      </Badge>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Created {formatDistanceToNow(new Date(token.createdAt), { addSuffix: true })}
                      {token.lastUsed && (
                        <> • Last used {formatDistanceToNow(new Date(token.lastUsed), { addSuffix: true })}</>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => deleteToken(token.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Quick Setup */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            Quick MCP Setup
          </CardTitle>
          <CardDescription>
            Simple installation for most users
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <p className="text-sm font-medium">1. Install the MCP server</p>
            <div className="relative">
              <pre className="rounded-lg bg-muted p-3 overflow-x-auto">
                <code className="font-mono text-sm">npm install -g pagespace-mcp@latest</code>
              </pre>
              <Button
                size="sm"
                variant="outline"
                className="absolute top-2 right-2"
                onClick={() => {
                  navigator.clipboard.writeText("npm install -g pagespace-mcp@latest");
                  toast.success("Command copied to clipboard");
                }}
              >
                <Copy className="h-3 w-3" />
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">2. Configure Claude with your MCP token</p>
            
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="token-select" className="text-sm">Select token:</Label>
                <select 
                  id="token-select"
                  className="flex h-9 w-64 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors"
                  value={selectedToken}
                  onChange={(e) => setSelectedToken(e.target.value)}
                >
                  <option value="">Choose a token...</option>
                  {tokens.map((token) => {
                    const actualToken = tokenMap.get(token.id);
                    return (
                      <option 
                        key={token.id} 
                        value={actualToken || ''} 
                        disabled={!actualToken}
                      >
                        {token.name} {!actualToken && '(token value not available)'}
                      </option>
                    );
                  })}
                </select>
              </div>
              {selectedToken && (
                <p className="text-xs text-muted-foreground">
                  ✓ Token selected and will be inserted into the configuration below
                </p>
              )}
              {!selectedToken && tokens.length > 0 && (
                <Alert className="mt-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <strong>Note:</strong> For security reasons, existing token values cannot be retrieved. 
                    Only newly created tokens in this session can be selected. To use an existing token, 
                    you&apos;ll need to create a new one.
                  </AlertDescription>
                </Alert>
              )}
            </div>
            
            
            {/* Configuration display */}
            <div className="space-y-2">
              <Label className="text-sm">3. Copy this configuration to your Claude settings:</Label>
            </div>
            
            <div className="relative">
              <pre className="rounded-lg bg-muted p-4 overflow-x-auto text-xs">
                <code className="font-mono">{generateConfig()}</code>
              </pre>
              <div className="absolute top-2 right-2 flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={copyConfig}
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const blob = new Blob([generateConfig()], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'mcp-config.json';
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>

        </CardContent>
      </Card>

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <strong>Security Notice:</strong> MCP tokens provide full access to read and edit your documents. 
          Keep them secure and only use them with trusted Claude instances. You can revoke tokens at any time.
        </AlertDescription>
      </Alert>
    </div>
  );
}