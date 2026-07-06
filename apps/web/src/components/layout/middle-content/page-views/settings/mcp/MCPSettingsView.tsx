'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Trash2, Copy, Plus, Eye, EyeOff, Key, Terminal, Check, Download, AlertTriangle, ArrowLeft, Shield, Code2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { useRouter } from 'next/navigation';
import { post, del, patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { attemptStepUp, readStepUpTokenFromHash, stripStepUpTokenFromHash } from '@/lib/auth/step-up-ceremony';
import { buildMintActionBinding, buildUpdateActionBinding, type DriveRoleSelection } from './mcp-token-step-up';

interface DriveScope {
  id: string;
  name: string;
  role: 'ADMIN' | 'MEMBER' | null;
  customRoleId?: string | null;
  customRoleName?: string | null;
}

interface MCPToken {
  id: string;
  name: string;
  lastUsed: string | null;
  createdAt: string;
  isScoped: boolean;
  driveScopes: DriveScope[];
}

interface NewToken extends MCPToken {
  token: string;
}

interface Drive {
  id: string;
  name: string;
  slug: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

interface DriveRoleOption {
  id: string;
  name: string;
  color?: string | null;
}

const INHERIT_VALUE = 'INHERIT';
const ADMIN_VALUE = 'ADMIN';
const MEMBER_VALUE = 'MEMBER';

function selectValueForRole(selection: DriveRoleSelection | undefined): string {
  if (!selection || selection.role === null) return INHERIT_VALUE;
  if (selection.role === 'ADMIN') return ADMIN_VALUE;
  if (selection.customRoleId) return selection.customRoleId;
  return MEMBER_VALUE;
}

function roleSelectionFromValue(value: string): DriveRoleSelection {
  if (value === INHERIT_VALUE) return { role: null, customRoleId: null };
  if (value === ADMIN_VALUE) return { role: 'ADMIN', customRoleId: null };
  if (value === MEMBER_VALUE) return { role: 'MEMBER', customRoleId: null };
  return { role: 'MEMBER', customRoleId: value };
}

function DriveRoleSelect({
  driveId,
  driveName,
  callerRole,
  selection,
  roles,
  onChange,
}: {
  driveId: string;
  driveName: string;
  callerRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  selection: DriveRoleSelection | undefined;
  roles: DriveRoleOption[] | undefined;
  onChange: (driveId: string, value: string) => void;
}) {
  const currentValue = selectValueForRole(selection);
  // Always render the currently-selected option even if the caller's ceiling would
  // otherwise hide it (e.g. Admin was granted earlier while the caller had a higher
  // role and they've since been downgraded to Member) — otherwise Radix Select shows
  // a blank trigger instead of the token's actual, still-in-effect scope.
  const showAdmin = callerRole !== 'MEMBER' || currentValue === ADMIN_VALUE;
  return (
    <Select value={currentValue} onValueChange={(value) => onChange(driveId, value)}>
      <SelectTrigger className="h-8 text-xs w-full" aria-label={`Role for ${driveName}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT_VALUE}>Inherit my access</SelectItem>
        {showAdmin && <SelectItem value={ADMIN_VALUE}>Admin</SelectItem>}
        <SelectItem value={MEMBER_VALUE}>Member</SelectItem>
        {roles && roles.length > 0 && (
          <>
            <SelectSeparator />
            {roles.map((role) => (
              <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>
            ))}
          </>
        )}
      </SelectContent>
    </Select>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {label && <span className="ml-1">{label}</span>}
    </Button>
  );
}

function OpenAIApiCard() {
  const baseUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/v1` : '/api/v1';

  const pythonSnippet = `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="YOUR_MCP_TOKEN",
)

stream = client.chat.completions.create(
    model="ps-agent://<pageId>",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)`;

  const tsSnippet = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: "YOUR_MCP_TOKEN",
});

const stream = await client.chat.completions.create({
  model: "ps-agent://<pageId>",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`;

  const curlSnippet = `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer YOUR_MCP_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "ps-agent://<pageId>",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Code2 className="h-5 w-5" />
          OpenAI-Compatible API
        </CardTitle>
        <CardDescription>
          Use any MCP token as an API key with the OpenAI SDK or any compatible client
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Base URL</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm">{baseUrl}</code>
            <CopyButton text={baseUrl} />
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-sm font-medium">Code examples</p>
          <Tabs defaultValue="python">
            <TabsList>
              <TabsTrigger value="python">Python</TabsTrigger>
              <TabsTrigger value="typescript">TypeScript</TabsTrigger>
              <TabsTrigger value="curl">curl</TabsTrigger>
            </TabsList>
            {[
              { value: 'python', code: pythonSnippet },
              { value: 'typescript', code: tsSnippet },
              { value: 'curl', code: curlSnippet },
            ].map(({ value, code }) => (
              <TabsContent key={value} value={value}>
                <div className="relative">
                  <pre className="rounded-lg bg-muted p-4 overflow-x-auto text-xs">
                    <code className="font-mono">{code}</code>
                  </pre>
                  <div className="absolute top-2 right-2">
                    <CopyButton text={code} />
                  </div>
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </div>

        <p className="text-xs text-muted-foreground">
          Replace <code className="rounded bg-muted px-1">YOUR_MCP_TOKEN</code> with any token from above.
          Replace <code className="rounded bg-muted px-1">ps-agent://&lt;pageId&gt;</code> with the model ID
          found on each agent&apos;s <strong>Settings</strong> tab.
        </p>
      </CardContent>
    </Card>
  );
}

// Minting and widening an MCP token's drive scopes are step-up gated (Phase 8
// credential minting security correction). A magic-link fallback redirects
// back to this same settings page, losing React state — sessionStorage
// carries the in-flight name/driveIds/roleSelections across that round trip,
// the URL fragment carries the resulting grant, and the mount effect below
// reconciles the two, mirroring `ConnectedAppsList`'s revoke-resume pattern.
const PENDING_MINT_STORAGE_KEY = 'pagespace:pendingMcpTokenMint';
const PENDING_UPDATE_STORAGE_KEY = 'pagespace:pendingMcpTokenUpdate';

type StepUpStatus = 'idle' | 'in_progress' | 'awaiting_email';

interface PendingMint {
  name: string;
  driveIds: string[];
  roleSelections: Record<string, DriveRoleSelection>;
}

interface PendingUpdate {
  tokenId: string;
  driveIds: string[];
  roleSelections: Record<string, DriveRoleSelection>;
}

export default function MCPSettingsView() {
  const router = useRouter();
  const [tokens, setTokens] = useState<MCPToken[]>([]);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createStepUpStatus, setCreateStepUpStatus] = useState<StepUpStatus>('idle');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [selectedDriveIds, setSelectedDriveIds] = useState<string[]>([]);
  const [newDriveRoles, setNewDriveRoles] = useState<Record<string, DriveRoleSelection>>({});
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const [editingTokenWasUnscoped, setEditingTokenWasUnscoped] = useState(false);
  const [editSelectedDriveIds, setEditSelectedDriveIds] = useState<string[]>([]);
  const [editDriveRoles, setEditDriveRoles] = useState<Record<string, DriveRoleSelection>>({});
  const [editingScopes, setEditingScopes] = useState(false);
  const [editStepUpStatus, setEditStepUpStatus] = useState<StepUpStatus>('idle');
  const [driveRolesByDriveId, setDriveRolesByDriveId] = useState<Record<string, DriveRoleOption[]>>({});
  const loadedRoleDriveIdsRef = useRef<Set<string>>(new Set());
  const [newToken, setNewToken] = useState<NewToken | null>(null);
  const [showNewToken, setShowNewToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [selectedToken, setSelectedToken] = useState('');
  const [tokenMap, setTokenMap] = useState<Map<string, string>>(new Map());
  const [setupStyle, setSetupStyle] = useState<'global' | 'npx'>('global');

  useEffect(() => {
    loadTokens();
    loadDrives();
  }, []);

  // A step-up magic link redirects back to this same settings URL with the
  // grant attached in the fragment — pick it up on load, scrub it from the
  // visible URL, and resume whichever mint/update was pending.
  useEffect(() => {
    const tokenFromEmail = readStepUpTokenFromHash(window.location.hash);
    if (!tokenFromEmail) return;
    const cleanedHash = stripStepUpTokenFromHash(window.location.hash);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${cleanedHash}`);

    const pendingMintRaw = sessionStorage.getItem(PENDING_MINT_STORAGE_KEY);
    if (pendingMintRaw) {
      sessionStorage.removeItem(PENDING_MINT_STORAGE_KEY);
      const pending = JSON.parse(pendingMintRaw) as PendingMint;
      finalizeCreateToken(pending.name, pending.driveIds, pending.roleSelections, tokenFromEmail);
      return;
    }

    const pendingUpdateRaw = sessionStorage.getItem(PENDING_UPDATE_STORAGE_KEY);
    if (pendingUpdateRaw) {
      sessionStorage.removeItem(PENDING_UPDATE_STORAGE_KEY);
      const pending = JSON.parse(pendingUpdateRaw) as PendingUpdate;
      finalizeUpdateTokenScopes(pending.tokenId, pending.driveIds, pending.roleSelections, tokenFromEmail);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ensureDriveRolesLoaded = async (driveId: string) => {
    if (loadedRoleDriveIdsRef.current.has(driveId)) return;
    loadedRoleDriveIdsRef.current.add(driveId);
    try {
      const response = await fetchWithAuth(`/api/drives/${driveId}/roles`);
      if (response.ok) {
        const { roles } = await response.json();
        setDriveRolesByDriveId(prev => ({
          ...prev,
          [driveId]: (roles as { id: string; name: string; color: string | null }[]).map(role => ({
            id: role.id,
            name: role.name,
            color: role.color,
          })),
        }));
      }
    } catch (error) {
      console.error('Error loading drive roles:', error);
      loadedRoleDriveIdsRef.current.delete(driveId);
    }
  };

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

  const loadDrives = async () => {
    try {
      // Only fetch drives that can be scoped to tokens (owned + member, not page-permission-only)
      const response = await fetchWithAuth('/api/drives?tokenScopable=true');
      if (response.ok) {
        const driveList = await response.json();
        setDrives(driveList);
      }
    } catch (error) {
      console.error('Error loading drives:', error);
    }
  };

  const buildDriveScopes = (
    driveIds: string[],
    roleSelections: Record<string, DriveRoleSelection>
  ): DriveScope[] =>
    driveIds.map(id => {
      const drive = drives.find(d => d.id === id);
      const selection = roleSelections[id] ?? { role: null, customRoleId: null };
      const customRole = selection.customRoleId
        ? driveRolesByDriveId[id]?.find(r => r.id === selection.customRoleId)
        : undefined;
      return {
        id,
        name: drive?.name || 'Unknown',
        role: selection.role,
        customRoleId: selection.customRoleId ?? null,
        customRoleName: customRole?.name ?? null,
      };
    });

  const finalizeCreateToken = async (
    name: string,
    driveIds: string[],
    roleSelections: Record<string, DriveRoleSelection>,
    stepUpToken: string,
  ) => {
    setCreating(true);
    try {
      const payload: {
        name: string;
        stepUpToken: string;
        drives?: { id: string; role: 'ADMIN' | 'MEMBER' | null; customRoleId?: string }[];
      } = { name, stepUpToken };
      if (driveIds.length > 0) {
        payload.drives = driveIds.map(id => {
          const selection = roleSelections[id] ?? { role: null, customRoleId: null };
          return { id, role: selection.role, customRoleId: selection.customRoleId ?? undefined };
        });
      }

      const token = await post<NewToken>('/api/auth/mcp-tokens', payload);

      // Add drive scopes to the token object for display
      const tokenWithScopes: MCPToken = {
        ...token,
        isScoped: driveIds.length > 0,
        driveScopes: buildDriveScopes(driveIds, roleSelections),
      };

      setNewToken(token);
      setTokens(prev => [tokenWithScopes, ...prev]);
      // Store the actual token value for the newly created token
      if (token.token) {
        setTokenMap(prev => new Map(prev).set(token.id, token.token));
        setSelectedToken(token.token);
      }
      setNewTokenName('');
      setSelectedDriveIds([]);
      setNewDriveRoles({});
      setCreateDialogOpen(false);
      setShowNewToken(true);
      setCreateStepUpStatus('idle');
      toast.success('MCP token created successfully');
    } catch (error) {
      console.error('Error creating MCP token:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to create MCP token');
      setCreateStepUpStatus('idle');
    } finally {
      setCreating(false);
    }
  };

  const createToken = async () => {
    if (creating || createStepUpStatus !== 'idle') return;
    if (!newTokenName.trim()) {
      toast.error('Please enter a name for the token');
      return;
    }

    const name = newTokenName.trim();
    const driveIds = selectedDriveIds;
    const roleSelections = newDriveRoles;

    setCreating(true);
    setCreateStepUpStatus('in_progress');
    try {
      const actionBinding = buildMintActionBinding(name, driveIds, roleSelections);
      const next = `${window.location.pathname}${window.location.search}`;
      const result = await attemptStepUp(actionBinding, next);
      if (result.status === 'awaiting_email') {
        // Only remember a pending mint once the email has actually been
        // dispatched — otherwise a failed request would leave pending state
        // behind with no corresponding link ever on its way.
        sessionStorage.setItem(PENDING_MINT_STORAGE_KEY, JSON.stringify({ name, driveIds, roleSelections }));
        setCreateStepUpStatus('awaiting_email');
        setCreating(false);
        return;
      }
      await finalizeCreateToken(name, driveIds, roleSelections, result.stepUpToken);
    } catch (error) {
      console.error('Error starting MCP token step-up:', error);
      toast.error('Something went wrong. Please try again.');
      setCreateStepUpStatus('idle');
      setCreating(false);
    }
  };

  const toggleDriveSelection = (driveId: string) => {
    setSelectedDriveIds(prev => {
      if (prev.includes(driveId)) return prev.filter(id => id !== driveId);
      ensureDriveRolesLoaded(driveId);
      return [...prev, driveId];
    });
  };

  const setNewDriveRole = (driveId: string, value: string) => {
    setNewDriveRoles(prev => ({ ...prev, [driveId]: roleSelectionFromValue(value) }));
  };

  const deleteToken = async (tokenId: string) => {
    try {
      await del(`/api/auth/mcp-tokens/${tokenId}`);

      setTokens(prev => prev.filter(token => token.id !== tokenId));
      toast.success('Token deleted successfully');
    } catch (error) {
      console.error('Error deleting MCP token:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete token');
    }
  };

  const openEditDialog = (token: MCPToken) => {
    setEditingTokenId(token.id);
    setEditingTokenWasUnscoped(!token.isScoped);
    setEditSelectedDriveIds(token.driveScopes.map(scope => scope.id));
    const roles: Record<string, DriveRoleSelection> = {};
    token.driveScopes.forEach(scope => {
      roles[scope.id] = { role: scope.role, customRoleId: scope.customRoleId ?? null };
      ensureDriveRolesLoaded(scope.id);
    });
    setEditDriveRoles(roles);
    setEditStepUpStatus('idle');
    setEditDialogOpen(true);
  };

  const toggleEditDriveSelection = (driveId: string) => {
    setEditSelectedDriveIds(prev => {
      if (prev.includes(driveId)) return prev.filter(id => id !== driveId);
      ensureDriveRolesLoaded(driveId);
      return [...prev, driveId];
    });
  };

  const setEditDriveRole = (driveId: string, value: string) => {
    setEditDriveRoles(prev => ({ ...prev, [driveId]: roleSelectionFromValue(value) }));
  };

  const finalizeUpdateTokenScopes = async (
    tokenId: string,
    driveIds: string[],
    roleSelections: Record<string, DriveRoleSelection>,
    stepUpToken: string,
  ) => {
    setEditingScopes(true);
    try {
      const driveScopesPayload = driveIds.map(id => {
        const selection = roleSelections[id] ?? { role: null, customRoleId: null };
        return { id, role: selection.role, customRoleId: selection.customRoleId ?? undefined };
      });

      await patch<{ id: string; name: string; driveScopes: { id: string; name: string }[] }>(
        `/api/auth/mcp-tokens/${tokenId}`,
        { drives: driveScopesPayload, stepUpToken }
      );

      // PATCH always sends an explicit drives array, so the token is always scoped
      // afterward (even [] means "scoped to zero drives", not "unscoped") — unlike
      // createToken()'s conditional isScoped, which reflects an omitted drives field.
      const nextDriveScopes = buildDriveScopes(driveIds, roleSelections);
      setTokens(prev => prev.map(t =>
        t.id === tokenId
          ? { ...t, driveScopes: nextDriveScopes, isScoped: true }
          : t
      ));
      setEditDialogOpen(false);
      setEditingTokenId(null);
      setEditingTokenWasUnscoped(false);
      setEditSelectedDriveIds([]);
      setEditDriveRoles({});
      setEditStepUpStatus('idle');
      toast.success('Token scopes updated successfully');
    } catch (error) {
      console.error('Error updating MCP token scopes:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update token scopes');
      setEditStepUpStatus('idle');
    } finally {
      setEditingScopes(false);
    }
  };

  const updateTokenScopes = async () => {
    if (editingScopes || editStepUpStatus !== 'idle') return;
    if (!editingTokenId) return;

    // This token currently has access to ALL drives (unscoped). Saving with no
    // drives selected would silently convert it to a NO-access token instead of
    // preserving all-drives access — require explicit confirmation for that case.
    if (editingTokenWasUnscoped && editSelectedDriveIds.length === 0) {
      const confirmed = window.confirm(
        'This token currently has access to ALL your drives. Saving with no drives ' +
        'selected will restrict it to NO drives, not leave it unrestricted. Continue?'
      );
      if (!confirmed) return;
    }

    const tokenId = editingTokenId;
    const driveIds = editSelectedDriveIds;
    const roleSelections = editDriveRoles;

    setEditingScopes(true);
    setEditStepUpStatus('in_progress');
    try {
      const actionBinding = buildUpdateActionBinding(tokenId, driveIds, roleSelections);
      const next = `${window.location.pathname}${window.location.search}`;
      const result = await attemptStepUp(actionBinding, next);
      if (result.status === 'awaiting_email') {
        // Only remember a pending update once the email has actually been
        // dispatched — otherwise a failed request would leave pending state
        // behind with no corresponding link ever on its way.
        sessionStorage.setItem(PENDING_UPDATE_STORAGE_KEY, JSON.stringify({ tokenId, driveIds, roleSelections }));
        setEditStepUpStatus('awaiting_email');
        setEditingScopes(false);
        return;
      }
      await finalizeUpdateTokenScopes(tokenId, driveIds, roleSelections, result.stepUpToken);
    } catch (error) {
      console.error('Error starting MCP token update step-up:', error);
      toast.error('Something went wrong. Please try again.');
      setEditStepUpStatus('idle');
      setEditingScopes(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Token copied to clipboard');
  };



  const generateConfig = (style: 'global' | 'npx' = setupStyle) => {
    const token = selectedToken || '<YOUR_PAGESPACE_MCP_TOKEN_HERE>';
    const launch = style === 'npx'
      ? { command: "npx", args: ["-y", "@pagespace/cli", "pagespace-mcp"] }
      : { command: "pagespace", args: ["mcp"] };
    const config = {
      mcpServers: {
        "pagespace": {
          ...launch,
          env: {
            PAGESPACE_API_URL: "https://pagespace.ai",
            PAGESPACE_TOKEN: token
          }
        }
      }
    };

    return JSON.stringify(config, null, 2);
  };

  const copyConfig = async (style: 'global' | 'npx') => {
    try {
      await navigator.clipboard.writeText(generateConfig(style));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Configuration copied to clipboard");
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const renderTokenSelectStep = (stepNumber: number) => (
    <div className="space-y-2">
      <p className="text-sm font-medium">{stepNumber}. Configure Claude with your MCP token</p>
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
  );

  const renderConfigStep = (style: 'global' | 'npx', stepNumber: number) => (
    <>
      <Label className="text-sm">{stepNumber}. Copy this configuration to your Claude settings:</Label>
      <div className="relative">
        <pre className="rounded-lg bg-muted p-4 overflow-x-auto text-xs">
          <code className="font-mono">{generateConfig(style)}</code>
        </pre>
        <div className="absolute top-2 right-2 flex gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => copyConfig(style)}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const blob = new Blob([generateConfig(style)], { type: 'application/json' });
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
    </>
  );

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
          Connect Claude Code, Claude Desktop, and other MCP clients to PageSpace.{' '}
          <code className="rounded bg-muted px-1">pagespace login</code> is for you, personally —
          it grants your full personal account access, so it isn&apos;t the right choice for an
          agent or MCP client. For an agent, CI job, or service account, mint a token scoped to
          specific drives instead — either below, or from the terminal with{' '}
          <code className="rounded bg-muted px-1">
            pagespace tokens create --drive &lt;id&gt; --save-as-profile agent
          </code>
          .
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
          <Dialog open={createDialogOpen} onOpenChange={(open) => {
              setCreateDialogOpen(open);
              if (!open) {
                setNewTokenName('');
                setSelectedDriveIds([]);
                setNewDriveRoles({});
                setCreateStepUpStatus('idle');
              }
            }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Create Token
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Create New MCP Token</DialogTitle>
                <DialogDescription>
                  Give your token a descriptive name and optionally restrict it to specific drives.
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

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    <Label>Drive Access Scope</Label>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {selectedDriveIds.length === 0
                      ? 'This token will have access to all your drives.'
                      : `This token will only have access to ${selectedDriveIds.length} selected drive${selectedDriveIds.length === 1 ? '' : 's'}.`}
                  </p>

                  {drives.length > 0 && (
                    <div className="border rounded-md p-3 max-h-64 overflow-y-auto space-y-3">
                      {drives.map((drive) => (
                        <div key={drive.id} className="space-y-1">
                          <div className="flex items-center space-x-2">
                            <Checkbox
                              id={`drive-${drive.id}`}
                              checked={selectedDriveIds.includes(drive.id)}
                              onCheckedChange={() => toggleDriveSelection(drive.id)}
                            />
                            <label
                              htmlFor={`drive-${drive.id}`}
                              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer flex-1"
                            >
                              {drive.name}
                            </label>
                          </div>
                          {selectedDriveIds.includes(drive.id) && (
                            <div className="pl-6">
                              <DriveRoleSelect
                                driveId={drive.id}
                                driveName={drive.name}
                                callerRole={drive.role}
                                selection={newDriveRoles[drive.id]}
                                roles={driveRolesByDriveId[drive.id]}
                                onChange={setNewDriveRole}
                              />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {selectedDriveIds.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      onClick={() => {
                        setSelectedDriveIds([]);
                        setNewDriveRoles({});
                      }}
                    >
                      Clear selection (allow all drives)
                    </Button>
                  )}
                </div>

                {createStepUpStatus === 'awaiting_email' && (
                  <p className="text-sm text-muted-foreground">
                    Check your email for a confirmation link to finish creating this token.
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={createToken} disabled={creating || createStepUpStatus === 'awaiting_email'}>
                  {createStepUpStatus === 'awaiting_email'
                    ? 'Check your email…'
                    : createStepUpStatus === 'in_progress'
                      ? 'Confirming…'
                      : creating
                        ? 'Creating...'
                        : 'Create Token'}
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
                      {token.driveScopes && token.driveScopes.length > 0 ? (
                        <Badge variant="outline" className="text-xs">
                          <Shield className="w-3 h-3 mr-1" />
                          {token.driveScopes.length} drive{token.driveScopes.length === 1 ? '' : 's'}
                        </Badge>
                      ) : token.isScoped ? (
                        <Badge variant="destructive" className="text-xs">
                          <AlertTriangle className="w-3 h-3 mr-1" />
                          No access
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          All drives
                        </Badge>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Created {formatDistanceToNow(new Date(token.createdAt), { addSuffix: true })}
                      {token.lastUsed && (
                        <> • Last used {formatDistanceToNow(new Date(token.lastUsed), { addSuffix: true })}</>
                      )}
                    </div>
                    {token.driveScopes && token.driveScopes.length > 0 && (
                      <div className="text-xs text-muted-foreground">
                        Access: {token.driveScopes.map(d => {
                          const roleLabel = d.role === 'ADMIN'
                            ? 'Admin'
                            : d.customRoleName || (d.role === 'MEMBER' ? 'Member' : null);
                          return roleLabel ? `${d.name} (${roleLabel})` : d.name;
                        }).join(', ')}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label="Edit token scopes"
                      onClick={() => openEditDialog(token)}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => deleteToken(token.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Edit Token Scopes */}
      <Dialog open={editDialogOpen} onOpenChange={(open) => {
          setEditDialogOpen(open);
          if (!open) {
            setEditingTokenId(null);
            setEditingTokenWasUnscoped(false);
            setEditSelectedDriveIds([]);
            setEditDriveRoles({});
            setEditStepUpStatus('idle');
          }
        }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Token Drive Scopes</DialogTitle>
            <DialogDescription>
              Change which drives this token can access.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-muted-foreground" />
                <Label>Drive Access Scope</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                {editSelectedDriveIds.length === 0
                  ? editingTokenWasUnscoped
                    ? 'This token currently has access to ALL your drives. Selecting none and saving will restrict it to NO drives, not leave it unrestricted.'
                    : 'This token will have access to 0 drives.'
                  : `This token will only have access to ${editSelectedDriveIds.length} selected drive${editSelectedDriveIds.length === 1 ? '' : 's'}.`}
              </p>

              {drives.length > 0 && (
                <div className="border rounded-md p-3 max-h-64 overflow-y-auto space-y-3">
                  {drives.map((drive) => (
                    <div key={drive.id} className="space-y-1">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id={`edit-drive-${drive.id}`}
                          checked={editSelectedDriveIds.includes(drive.id)}
                          onCheckedChange={() => toggleEditDriveSelection(drive.id)}
                        />
                        <label
                          htmlFor={`edit-drive-${drive.id}`}
                          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer flex-1"
                        >
                          {drive.name}
                        </label>
                      </div>
                      {editSelectedDriveIds.includes(drive.id) && (
                        <div className="pl-6">
                          <DriveRoleSelect
                            driveId={drive.id}
                            driveName={drive.name}
                            callerRole={drive.role}
                            selection={editDriveRoles[drive.id]}
                            roles={driveRolesByDriveId[drive.id]}
                            onChange={setEditDriveRole}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {editSelectedDriveIds.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    setEditSelectedDriveIds([]);
                    setEditDriveRoles({});
                  }}
                >
                  Clear selection (revoke all access)
                </Button>
              )}
            </div>

            {editStepUpStatus === 'awaiting_email' && (
              <p className="text-sm text-muted-foreground">
                Check your email for a confirmation link to finish saving these changes.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={updateTokenScopes} disabled={editingScopes || editStepUpStatus === 'awaiting_email'}>
              {editStepUpStatus === 'awaiting_email'
                ? 'Check your email…'
                : editStepUpStatus === 'in_progress'
                  ? 'Confirming…'
                  : editingScopes
                    ? 'Saving...'
                    : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
          <Tabs value={setupStyle} onValueChange={(value) => setSetupStyle(value as 'global' | 'npx')}>
            <TabsList>
              <TabsTrigger value="global">Global install</TabsTrigger>
              <TabsTrigger value="npx">No install (npx)</TabsTrigger>
            </TabsList>

            <TabsContent value="global" className="space-y-6 pt-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">1. Install the pagespace CLI</p>
                <div className="relative">
                  <pre className="rounded-lg bg-muted p-3 overflow-x-auto">
                    <code className="font-mono text-sm">npm install -g @pagespace/cli</code>
                  </pre>
                  <Button
                    size="sm"
                    variant="outline"
                    className="absolute top-2 right-2"
                    onClick={() => {
                      navigator.clipboard.writeText("npm install -g @pagespace/cli");
                      toast.success("Command copied to clipboard");
                    }}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  This installs <code className="rounded bg-muted px-1">pagespace mcp</code>, which the
                  config below points at. Don&apos;t authenticate it with{' '}
                  <code className="rounded bg-muted px-1">pagespace login</code> — that&apos;s your
                  personal account access. Instead run{' '}
                  <code className="rounded bg-muted px-1">
                    pagespace tokens create --drive &lt;id&gt; --save-as-profile agent
                  </code>{' '}
                  once, then swap <code className="rounded bg-muted px-1">PAGESPACE_TOKEN</code> in the
                  config below for <code className="rounded bg-muted px-1">PAGESPACE_PROFILE: &quot;agent&quot;</code>{' '}
                  — the MCP will reuse that scoped credential instead of a portable token.
                </p>
              </div>

              {renderTokenSelectStep(2)}

              <div className="space-y-2">
                {renderConfigStep('global', 3)}
              </div>
            </TabsContent>

            <TabsContent value="npx" className="space-y-6 pt-4">
              <p className="text-xs text-muted-foreground">
                No install step — <code className="rounded bg-muted px-1">npx</code> fetches{' '}
                <code className="rounded bg-muted px-1">@pagespace/cli</code> on demand each time the MCP
                client launches it.
              </p>

              {renderTokenSelectStep(1)}

              <div className="space-y-2">
                {renderConfigStep('npx', 2)}
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* OpenAI-Compatible API */}
      <OpenAIApiCard />

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <strong>Security Notice:</strong> MCP tokens provide access to read and edit your documents.
          For better security, you can scope tokens to specific drives to limit access.
          Keep tokens secure and only use them with trusted Claude instances. You can revoke tokens at any time.
        </AlertDescription>
      </Alert>
    </div>
  );
}