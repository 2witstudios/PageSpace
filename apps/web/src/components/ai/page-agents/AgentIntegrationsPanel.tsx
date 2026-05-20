'use client';

import { useState, useMemo, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Plug2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useAgentGrants, useUserConnections, useDriveConnections } from '@/hooks/useIntegrations';
import { IntegrationStatusBadge } from '@/components/integrations/IntegrationStatusBadge';
import { post, put, del } from '@/lib/auth/auth-fetch';
import type { SafeConnection, SafeGrant } from '@/components/integrations/types';
import { useSocket } from '@/hooks/useSocket';
import type { AgentGrantChangedPayload } from '@/lib/websocket/socket-utils';

interface AgentIntegrationsPanelProps {
  pageId: string;
  driveId: string;
}

type ProviderTool = NonNullable<NonNullable<SafeGrant['connection']>['provider']>['tools'][number];

const getProviderTools = (grant: SafeGrant): ProviderTool[] =>
  grant.connection?.provider?.tools ?? [];

// When allowedTools is null, the runtime gate (is-tool-allowed.ts) permits every
// non-dangerous tool but blocks dangerous ones until they are explicitly listed.
// Mirror that here so the UI does not silently elevate dangerous tools when the
// user makes a routine edit that promotes the implicit list to an explicit one.
const getEffectiveAllowed = (grant: SafeGrant, tools: ProviderTool[]): Set<string> =>
  grant.allowedTools === null
    ? new Set(tools.filter((t) => t.category !== 'dangerous').map((t) => t.id))
    : new Set(grant.allowedTools);

export function AgentIntegrationsPanel({ pageId, driveId }: AgentIntegrationsPanelProps) {
  const { grants, isLoading: loadingGrants, error: grantsError, mutate: mutateGrants } = useAgentGrants(pageId);
  const { connections: userConnections, isLoading: loadingUser, error: userError } = useUserConnections();
  const { connections: driveConnections, isLoading: loadingDrive, error: driveError } = useDriveConnections(driveId);
  const socket = useSocket();

  const [toggling, setToggling] = useState<string | null>(null);
  const [updatingGrant, setUpdatingGrant] = useState<string | null>(null);

  useEffect(() => {
    if (!socket) return;
    const handleGrantChanged = (payload: AgentGrantChangedPayload) => {
      if (payload.agentId !== pageId) return;
      mutateGrants();
    };
    socket.on('agent:grant_changed', handleGrantChanged);
    return () => {
      socket.off('agent:grant_changed', handleGrantChanged);
    };
  }, [socket, pageId, mutateGrants]);

  const isLoading = loadingGrants || loadingUser || loadingDrive;
  const error = grantsError || userError || driveError;

  const allConnections = useMemo(() => {
    const seen = new Map<string, SafeConnection>();
    for (const c of userConnections) seen.set(c.id, c);
    for (const c of driveConnections) {
      if (!seen.has(c.id)) seen.set(c.id, c);
    }
    return Array.from(seen.values());
  }, [userConnections, driveConnections]);

  const grantByConnectionId = useMemo(
    () => new Map(grants.map((g) => [g.connectionId, g])),
    [grants]
  );

  const handleToggle = async (connection: SafeConnection, enabled: boolean) => {
    setToggling(connection.id);
    try {
      if (enabled) {
        await post(`/api/agents/${pageId}/integrations`, {
          connectionId: connection.id,
        });
        toast.success(`Enabled ${connection.name}`);
      } else {
        const grant = grantByConnectionId.get(connection.id);
        if (grant) {
          await del(`/api/agents/${pageId}/integrations/${grant.id}`);
          toast.success(`Disabled ${connection.name}`);
        }
      }
      mutateGrants();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      setToggling(null);
    }
  };

  const handleUpdateGrant = async (grant: SafeGrant, updates: {
    readOnly?: boolean;
    allowedTools?: string[] | null;
  }) => {
    setUpdatingGrant(grant.id);
    try {
      await put(`/api/agents/${pageId}/integrations/${grant.id}`, updates);
      mutateGrants();
    } catch {
      toast.error('Failed to update grant settings');
    } finally {
      setUpdatingGrant(null);
    }
  };

  const handleToggleTool = (grant: SafeGrant, toolId: string, checked: boolean) => {
    const tools = getProviderTools(grant);
    const current = getEffectiveAllowed(grant, tools);
    if (checked) {
      current.add(toolId);
    } else {
      current.delete(toolId);
    }
    handleUpdateGrant(grant, {
      allowedTools: tools.filter((t) => current.has(t.id)).map((t) => t.id),
    });
  };

  const handleSelectAllTools = (grant: SafeGrant) => {
    const tools = getProviderTools(grant);
    const allIds = tools.map((t) => t.id);
    const current = grant.allowedTools;
    if (current && current.length === allIds.length && allIds.every((id) => current.includes(id))) return;
    handleUpdateGrant(grant, { allowedTools: allIds });
  };

  const handleDeselectAllTools = (grant: SafeGrant) => {
    if (Array.isArray(grant.allowedTools) && grant.allowedTools.length === 0) return;
    handleUpdateGrant(grant, { allowedTools: [] });
  };

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Plug2 className="h-4 w-4" />
          Integration Tools
        </CardTitle>
        <CardDescription>
          Enable external integrations and choose which of their tools the agent can use.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 p-4 text-sm text-destructive bg-destructive/10 rounded-lg">
            <AlertCircle className="h-4 w-4" />
            <span>Failed to load integrations</span>
          </div>
        ) : allConnections.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>
              No integrations available. Connect integrations in Settings &rarr; Integrations.
            </span>
          </div>
        ) : (
          <div className="space-y-3">
            {allConnections.map((connection) => {
              const grant = grantByConnectionId.get(connection.id);
              const isEnabled = !!grant;
              const isActive = connection.status === 'active';
              const tools = grant ? getProviderTools(grant) : [];
              const allowed = grant ? getEffectiveAllowed(grant, tools) : new Set<string>();

              return (
                <div key={connection.id} className="border rounded-lg">
                  <div className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-1.5 rounded-full bg-muted flex-shrink-0">
                        <Plug2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{connection.name}</span>
                          <IntegrationStatusBadge status={connection.status} />
                          {connection.visibility && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0">
                              {connection.visibility === 'private' ? 'User' : 'Drive'}
                            </Badge>
                          )}
                        </div>
                        {connection.provider && (
                          <p className="text-xs text-muted-foreground">{connection.provider.name}</p>
                        )}
                      </div>
                    </div>
                    <Switch
                      checked={isEnabled}
                      disabled={!isActive || toggling === connection.id}
                      onCheckedChange={(checked) => handleToggle(connection, checked)}
                      aria-label={`Enable ${connection.name} integration`}
                    />
                  </div>

                  {grant && (
                    <div className="border-t px-3 py-3 space-y-3 bg-muted/30">
                      <div className="flex items-center justify-between">
                        <Label htmlFor={`readonly-${grant.id}`} className="text-xs">
                          Read-only mode
                        </Label>
                        <Switch
                          id={`readonly-${grant.id}`}
                          checked={grant.readOnly}
                          disabled={updatingGrant === grant.id}
                          onCheckedChange={(readOnly) => handleUpdateGrant(grant, { readOnly })}
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs">Tools</Label>
                          <div className="flex space-x-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={updatingGrant === grant.id || tools.length === 0}
                              onClick={() => handleSelectAllTools(grant)}
                            >
                              Select All
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={updatingGrant === grant.id || tools.length === 0}
                              onClick={() => handleDeselectAllTools(grant)}
                            >
                              Deselect All
                            </Button>
                          </div>
                        </div>
                        {tools.length === 0 ? (
                          <p className="text-xs text-muted-foreground py-2">
                            This integration does not expose any tools.
                          </p>
                        ) : (
                          <>
                            <div className="space-y-2">
                              {tools.map((tool) => {
                                const id = `tool-${grant.id}-${tool.id}`;
                                return (
                                  <div
                                    key={tool.id}
                                    className="flex items-start space-x-3 p-2 rounded-lg hover:bg-muted/50"
                                  >
                                    <Checkbox
                                      id={id}
                                      checked={allowed.has(tool.id)}
                                      disabled={updatingGrant === grant.id}
                                      onCheckedChange={(checked) =>
                                        handleToggleTool(grant, tool.id, checked === true)
                                      }
                                      className="mt-1"
                                    />
                                    <div className="flex-1">
                                      <label
                                        htmlFor={id}
                                        className="text-sm font-medium cursor-pointer"
                                      >
                                        {tool.name}
                                      </label>
                                      <p className="text-xs text-muted-foreground">
                                        {tool.description}
                                      </p>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Selected {allowed.size} of {tools.length} tools
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
