'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Trash2, Copy, Plus, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { post, del, fetchWithAuth } from '@/lib/auth-fetch';

interface MCPToken {
  id: string;
  name: string;
  lastUsed: string | null;
  createdAt: string;
}

interface NewToken extends MCPToken {
  token: string;
}

export function MCPTokenManager() {
  const [tokens, setTokens] = useState<MCPToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [newToken, setNewToken] = useState<NewToken | null>(null);
  const [showNewToken, setShowNewToken] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');

  useEffect(() => {
    loadTokens();
    // Set the base URL from the current window location
    if (typeof window !== 'undefined') {
      setBaseUrl(window.location.origin);
    }
  }, []);

  const loadTokens = async () => {
    try {
      const response = await fetchWithAuth('/api/auth/mcp-tokens');
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
      const token = await post<NewToken>('/api/auth/mcp-tokens', { name: newTokenName.trim() });
      setNewToken(token);
      setNewTokenName('');
      setShowNewToken(true);
      await loadTokens(); // Refresh the list
      toast.success('MCP token created successfully');
    } catch (error) {
      console.error('Error creating MCP token:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to create MCP token');
    } finally {
      setCreating(false);
    }
  };

  const deleteToken = async (tokenId: string) => {
    try {
      await del(`/api/auth/mcp-tokens/${tokenId}`);
      await loadTokens(); // Refresh the list
      toast.success('Token revoked successfully');
    } catch (error) {
      console.error('Error revoking MCP token:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to revoke token');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Token copied to clipboard');
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>MCP Tokens</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP Tokens</CardTitle>
        <CardDescription>
          Create and manage MCP (Model Context Protocol) tokens for Claude Code and Claude Desktop integration.
          These tokens allow external tools to read and edit your documents.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* New Token Creation */}
        <div className="space-y-3">
          <Label htmlFor="token-name">Create New Token</Label>
          <div className="flex gap-2">
            <Input
              id="token-name"
              placeholder="e.g., Claude Desktop, Development"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createToken()}
            />
            <Button
              onClick={createToken}
              disabled={creating || !newTokenName.trim()}
            >
              {creating ? 'Creating...' : (
                <>
                  <Plus className="w-4 h-4 mr-2" />
                  Create
                </>
              )}
            </Button>
          </div>
        </div>

        {/* New Token Display */}
        {newToken && (
          <Card className="border-green-500/20 bg-green-500/10 dark:border-green-500/30 dark:bg-green-500/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Token Created!</CardTitle>
              <CardDescription>
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
                    <code className="flex-1 p-2 bg-background border rounded text-sm font-mono">
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
                  Dismiss
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Existing Tokens */}
        <div className="space-y-3">
          <Label>Existing Tokens</Label>
          {tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">No MCP tokens created yet.</p>
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
        </div>

        {/* Setup Instructions */}
        <div className="mt-8 p-4 border rounded-lg bg-muted/50">
          <h4 className="font-medium mb-2">Setup Instructions</h4>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>To use your MCP token with Claude Code or Claude Desktop:</p>
            <ol className="list-decimal list-inside space-y-1 ml-2">
              <li>Add this configuration to your Claude MCP settings:</li>
            </ol>
            <pre className="bg-background p-2 rounded text-xs overflow-x-auto">
{`{
  "mcpServers": {
    "pagespace": {
      "command": "node",
      "args": ["/path/to/pagespace/mcp-server/index.js"],
      "env": {
        "PAGESPACE_API_URL": "${baseUrl}",
        "PAGESPACE_AUTH_TOKEN": "your_mcp_token_here"
      }
    }
  }
}`}
            </pre>
            <p>Replace <code>/path/to/pagespace</code> with your actual PageSpace directory path and <code>your_mcp_token_here</code> with your MCP token.</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}