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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Trash2, Copy, Plus, Eye, EyeOff, Key, Terminal, Check, Download, Settings, Search, AlertTriangle, ArrowLeft } from 'lucide-react';
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

interface DetectionResult {
  nodePath?: string;
  npmPath?: string;
  error?: string;
  platform?: string;
  detectionLog?: string[];
  foundPaths?: {
    node: string[];
    npm: string[];
  };
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
  const [showAdvancedSetup, setShowAdvancedSetup] = useState(false);
  const [nodePath, setNodePath] = useState('');
  const [npmPath, setNpmPath] = useState('');
  const [configTemplate, setConfigTemplate] = useState<'placeholder' | 'detected' | 'nvm' | 'homebrew' | 'system' | 'windows-program' | 'windows-user'>('placeholder');
  const [detectingPaths, setDetectingPaths] = useState(false);
  const [detectedPlatform, setDetectedPlatform] = useState<'windows' | 'unix' | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedToken, setSelectedToken] = useState('');
  const [tokenMap, setTokenMap] = useState<Map<string, string>>(new Map());
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

  const detectPaths = async () => {
    setDetectingPaths(true);
    try {
      const response = await fetch('/api/mcp/detect-paths');
      const data: DetectionResult = await response.json();
      
      // Log detection details for debugging
      if (data.detectionLog) {
        console.log('Path Detection Log:', data.detectionLog);
      }
      if (data.foundPaths) {
        console.log('Found Paths:', data.foundPaths);
      }
      
      if (response.ok) {
        let hasDetectedPaths = false;
        if (data.nodePath) {
          setNodePath(data.nodePath);
          hasDetectedPaths = true;
        }
        if (data.npmPath) {
          setNpmPath(data.npmPath);
          hasDetectedPaths = true;
        }
        if (data.platform) {
          setDetectedPlatform(data.platform as 'windows' | 'unix');
        }
        if (hasDetectedPaths) {
          setConfigTemplate('detected');
          if (data.nodePath && data.npmPath) {
            toast.success(`Both paths detected! Node: ${data.nodePath.split('/').pop()}, NPM: ${data.npmPath.split('/').pop()}`);
          } else if (data.nodePath) {
            toast.success(`Node detected: ${data.nodePath.split('/').pop()}. NPM path constructed.`);
          } else if (data.npmPath) {
            toast.success(`NPM detected: ${data.npmPath.split('/').pop()}. Please verify Node path.`);
          }
        } else {
          // Show debug info in error case
          const strategies = data.detectionLog?.length || 0;
          toast.error(`Detection failed after ${strategies} strategies. Check console for details.`);
        }
      } else {
        const errorMsg = data.error || 'Could not detect paths automatically';
        toast.error(errorMsg);
        if (data.detectionLog?.length) {
          console.error('Detection failed. Log:', data.detectionLog);
          toast.info('Check browser console for detailed detection log');
        }
        
        if (data.platform) {
          setDetectedPlatform(data.platform as 'windows' | 'unix');
        }
        
        // If Windows, suggest Windows template
        if (data.platform === 'windows') {
          setConfigTemplate('windows-user');
          toast.info('Switched to Windows template. Please verify the paths.');
        }
      }
    } catch (error) {
      console.error('Error detecting paths:', error);
      toast.error('Failed to detect paths. Network or server error.');
    } finally {
      setDetectingPaths(false);
    }
  };

  const getConfigPaths = () => {
    const isWindows = detectedPlatform === 'windows' || 
                      (typeof window !== 'undefined' && navigator.platform.includes('Win'));
    
    switch (configTemplate) {
      case 'placeholder':
        return {
          command: '<REPLACE_WITH_NODE_PATH>',
          args: ['<REPLACE_WITH_NPM_GLOBAL_PATH>/pagespace-mcp/index.js'],
          comment: isWindows 
            ? '// Run "where node" and "npm root -g" to find these paths'
            : '// Run "which node" and "npm root -g" to find these paths'
        };
      case 'detected':
        // Use detected paths when available, with intelligent fallbacks
        const detectedNodePath = nodePath || '<CLICK_AUTO_DETECT_FOR_NODE_PATH>';
        let detectedNpmPath = npmPath;
        
        // If npm path not detected but node path is, try to construct it
        if (!detectedNpmPath && nodePath) {
          if (isWindows) {
            // Windows: try to construct npm global path from node path
            if (nodePath.includes('Program Files')) {
              detectedNpmPath = nodePath.replace('\\node.exe', '\\node_modules\\npm\\node_modules');
            } else if (nodePath.includes('AppData')) {
              detectedNpmPath = nodePath.replace('\\bin\\node.exe', '\\lib\\node_modules');
            }
          } else {
            // Unix: construct from node path
            detectedNpmPath = nodePath.replace('/bin/node', '/lib/node_modules');
          }
        }
        
        // Final fallback if still no npm path
        if (!detectedNpmPath) {
          detectedNpmPath = '<CLICK_AUTO_DETECT_FOR_NPM_PATH>';
        }
        
        const comment = nodePath && npmPath 
          ? '// Auto-detected paths' 
          : nodePath 
            ? '// Node path detected, npm path constructed/needs detection'
            : '// Paths need detection - click Auto-Detect button';
        
        return {
          command: detectedNodePath,
          args: [`${detectedNpmPath}/pagespace-mcp/index.js`],
          comment
        };
      case 'nvm':
        return {
          command: '~/.nvm/versions/node/vXX.XX.X/bin/node',
          args: ['~/.nvm/versions/node/vXX.XX.X/lib/node_modules/pagespace-mcp/index.js'],
          comment: '// Replace XX.XX.X with your Node version'
        };
      case 'homebrew':
        return {
          command: '/opt/homebrew/bin/node',
          args: ['/opt/homebrew/lib/node_modules/pagespace-mcp/index.js'],
          comment: '// Common paths for Apple Silicon Macs with Homebrew'
        };
      case 'system':
        return {
          command: '/usr/local/bin/node',
          args: ['/usr/local/lib/node_modules/pagespace-mcp/index.js'],
          comment: '// Common system-wide installation paths'
        };
      case 'windows-program':
        return {
          command: 'C:\\Program Files\\nodejs\\node.exe',
          args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\node_modules\\pagespace-mcp\\index.js'],
          comment: '// Windows system-wide installation (Program Files)'
        };
      case 'windows-user':
        return {
          command: 'C:\\Program Files\\nodejs\\node.exe',
          args: ['C:\\Users\\[USERNAME]\\AppData\\Roaming\\npm\\node_modules\\pagespace-mcp\\index.js'],
          comment: '// Windows user installation - replace [USERNAME] with your Windows username'
        };
      default:
        return {
          command: nodePath || '/usr/local/bin/node',
          args: [`${npmPath || '/usr/local/lib/node_modules'}/pagespace-mcp/index.js`],
          comment: ''
        };
    }
  };

  const generateAdvancedConfig = () => {
    const token = selectedToken || '<YOUR_PAGESPACE_MCP_TOKEN_HERE>';
    const paths = getConfigPaths();
    const config = {
      mcpServers: {
        "pagespace": {
          command: paths.command,
          args: paths.args,
          env: {
            PAGESPACE_API_URL: baseUrl,
            PAGESPACE_AUTH_TOKEN: token
          }
        }
      }
    };
    
    let configStr = JSON.stringify(config, null, 2);
    if (paths.comment) {
      // Add comment after opening brace
      configStr = configStr.replace('{\n  "mcpServers":', `{\n  ${paths.comment}\n  "mcpServers":`);
    }
    return configStr;
  };

  const copyAdvancedConfig = async () => {
    try {
      await navigator.clipboard.writeText(generateAdvancedConfig());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Advanced configuration copied to clipboard");
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
            <p className="text-sm font-medium">2. Configure your MCP settings</p>
            
            {/* Path Configuration Options */}
            <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Path Configuration</Label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={detectPaths}
                    disabled={detectingPaths}
                  >
                    <Search className="h-3 w-3 mr-1" />
                    {detectingPaths ? 'Detecting...' : 'Auto-Detect'}
                  </Button>
                  <Select 
                    value={configTemplate} 
                    onValueChange={(value) => setConfigTemplate(value as typeof configTemplate)}
                  >
                    <SelectTrigger className="w-[180px] h-8">
                      <SelectValue placeholder="Choose template" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="placeholder">Placeholder (Manual)</SelectItem>
                      <SelectItem value="detected">Auto-Detected</SelectItem>
                      <SelectItem value="nvm">NVM Setup</SelectItem>
                      <SelectItem value="homebrew">Homebrew (Mac)</SelectItem>
                      <SelectItem value="system">System Default</SelectItem>
                      <SelectItem value="windows-program">Windows (Program Files)</SelectItem>
                      <SelectItem value="windows-user">Windows (User)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <div className="text-xs text-muted-foreground space-y-1">
                <p>💡 <strong>Tip:</strong> Click &quot;Auto-Detect&quot; to find your Node and npm paths automatically</p>
                <p>📍 Or select a template that matches your setup</p>
              </div>
            </div>

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
            
            {/* Show detected paths if available */}
            {configTemplate === 'detected' && (nodePath || npmPath) && (
              <Alert className="mt-2">
                <Check className="h-4 w-4" />
                <AlertDescription>
                  <strong>Detected Paths:</strong>
                  <div className="mt-1 font-mono text-xs">
                    {nodePath ? (
                      <div>✓ Node: {nodePath}</div>
                    ) : (
                      <div>⚠ Node: Click Auto-Detect to find</div>
                    )}
                    {npmPath ? (
                      <div>✓ NPM: {npmPath}</div>
                    ) : nodePath ? (
                      <div>⚠ NPM: Will be constructed from Node path</div>
                    ) : (
                      <div>⚠ NPM: Click Auto-Detect to find</div>
                    )}
                  </div>
                  {nodePath && !npmPath && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      💡 NPM path will be automatically constructed based on your Node installation
                    </div>
                  )}
                </AlertDescription>
              </Alert>
            )}
            
            {/* Configuration display with helpful hints */}
            <div className="space-y-2">
              <Label className="text-sm">3. Copy this configuration:</Label>
              {configTemplate === 'placeholder' && (
                <Alert className="mb-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    <strong>Action Required:</strong> Replace the placeholder values in the config below:
                    <ul className="mt-1 ml-4 list-disc">
                      <li>
                        {detectedPlatform === 'windows' ? (
                          <>Run <code className="bg-muted px-1 rounded">where node</code> to find your Node path</>
                        ) : (
                          <>Run <code className="bg-muted px-1 rounded">which node</code> to find your Node path</>
                        )}
                      </li>
                      <li>Run <code className="bg-muted px-1 rounded">npm root -g</code> to find your npm global path</li>
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              {(configTemplate === 'windows-user' || configTemplate === 'windows-program') && (
                <Alert className="mb-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    <strong>Windows Users:</strong> 
                    {configTemplate === 'windows-user' && (
                      <> Replace [USERNAME] with your Windows username (e.g., &quot;Chase&quot;, &quot;John&quot;, etc.)</>
                    )}
                    {configTemplate === 'windows-program' && (
                      <> This template assumes Node.js is installed in Program Files. Verify the path exists.</>
                    )}
                  </AlertDescription>
                </Alert>
              )}
            </div>
            
            <div className="relative">
              <pre className="rounded-lg bg-muted p-4 overflow-x-auto text-xs">
                <code className="font-mono">{generateAdvancedConfig()}</code>
              </pre>
              <div className="absolute top-2 right-2 flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={copyAdvancedConfig}
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const blob = new Blob([generateAdvancedConfig()], { type: 'application/json' });
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

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAdvancedSetup(!showAdvancedSetup)}
            >
              <Settings className="h-4 w-4 mr-2" />
              {showAdvancedSetup ? 'Hide' : 'Show'} Advanced Setup
            </Button>
          </div>

          {showAdvancedSetup && (
            <div className="space-y-4 border-t pt-4">
              <h4 className="font-medium text-sm">Custom Path Configuration</h4>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="nodePath" className="text-sm">Node.js Path</Label>
                  <Input
                    id="nodePath"
                    value={nodePath}
                    onChange={(e) => setNodePath(e.target.value)}
                    placeholder="/usr/local/bin/node"
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Run <code className="bg-muted px-1 rounded">which node</code> to find this
                  </p>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="npmPath" className="text-sm">Global Modules Path (optional)</Label>
                  <Input
                    id="npmPath"
                    value={npmPath}
                    onChange={(e) => setNpmPath(e.target.value)}
                    placeholder="Auto-detected from Node.js path"
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Run <code className="bg-muted px-1 rounded">npm root -g</code> to find this
                  </p>
                </div>
              </div>
            </div>
          )}
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