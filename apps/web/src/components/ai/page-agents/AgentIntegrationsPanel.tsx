'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Plug2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useAgentGrants, useUserConnections, useDriveConnections } from '@/hooks/useIntegrations';
import { IntegrationStatusBadge } from '@/components/integrations/IntegrationStatusBadge';
import { post, put, del } from '@/lib/auth/auth-fetch';
import type { SafeConnection, SafeGrant } from '@/components/integrations/types';

interface AgentIntegrationsPanelProps {
  pageId: string;
  driveId: string;
}

export function AgentIntegrationsPanel({ pageId, driveId }: AgentIntegrationsPanelProps) {
  const { grants, isLoading: loadingGrants, error: grantsError, mutate: mutateGrants } = useAgentGrants(pageId);
  const { connections: userConnections, isLoading: loadingUser, error: userError } = useUserConnections();
  const { connections: driveConnections, isLoading: loadingDrive, error: driveError } = useDriveConnections(driveId);

  const [toggling, setToggling] = useState<string | null>(null);
  const [updatingGrant, setUpdatingGrant] = useState<string | null>(null);

  const isLoading = loadingGrants || loadingUser || loadingDrive;
  const error = grantsError || userError || driveError;

  // Merge user + drive connections, deduplicate by id (O(n) with Map)
  const allConnections = useMemo(() => {
    const seen = new Map<string, SafeConnection>();
    for (const c of userConnections) seen.set(c.id, c);
    for (const c of driveConnections) {
      if (!seen.has(c.id)) seen.set(c.id, c);
    }
    return Array.from(seen.values());
  }, [userConnections, driveConnections]);

  // Map connectionId -> grant for quick lookup
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update');
    } finally {
      setToggling(null);
    }
  };

  const handleUpdateGrant = async (grant: SafeGrant, updates: {
    readOnly?: boolean;
    rateLimitOverride?: { requestsPerMinute?: number } | null;
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

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Plug2 className="h-4 w-4" />
          External Integrations
        </CardTitle>
        <CardDescription>
          Enable external API connections for this agent.
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
                    />
                  </div>

                  {/* Expanded config when enabled */}
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
                      <div className="space-y-1">
                        <Label htmlFor={`ratelimit-${grant.id}`} className="text-xs">
                          Rate limit (req/min, optional)
                        </Label>
                        <Input
                          key={`ratelimit-${grant.id}-${grant.rateLimitOverride?.requestsPerMinute ?? 'default'}`}
                          id={`ratelimit-${grant.id}`}
                          type="number"
                          min={1}
                          max={1000}
                          placeholder="Default"
                          className="h-7 text-xs"
                          defaultValue={grant.rateLimitOverride?.requestsPerMinute ?? ''}
                          disabled={updatingGrant === grant.id}
                          onBlur={(e) => {
                            const val = e.target.value ? parseInt(e.target.value, 10) : null;
                            const current = grant.rateLimitOverride?.requestsPerMinute ?? null;
                            if (val !== current) {
                              handleUpdateGrant(grant, {
                                rateLimitOverride: val ? { requestsPerMinute: val } : null,
                              });
                            }
                          }}
                        />
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
