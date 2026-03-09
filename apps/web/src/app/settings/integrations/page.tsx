'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, Cable, Plug2, Loader2, ExternalLink, AlertCircle, Package, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { useProviders, useUserConnections, useAvailableBuiltins } from '@/hooks/useIntegrations';
import { IntegrationStatusBadge } from '@/components/integrations/IntegrationStatusBadge';
import { ConnectIntegrationDialog } from '@/components/integrations/ConnectIntegrationDialog';
import { DisconnectWithAgentCount } from '@/components/integrations/DisconnectConfirmDialog';
import { del, patch, post } from '@/lib/auth/auth-fetch';
import type { SafeProvider, SafeConnection } from '@/components/integrations/types';

const visibilityLabels: Record<string, string> = {
  private: 'Private',
  owned_drives: 'Your drives',
  all_drives: 'All drives',
};

export default function IntegrationsSettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { providers, isLoading: loadingProviders, error: providersError, mutate: mutateProviders } = useProviders();
  const { connections, isLoading: loadingConnections, error: connectionsError, mutate: mutateConnections } = useUserConnections();

  const { builtins, isLoading: loadingBuiltins, error: builtinsError, mutate: mutateBuiltins } = useAvailableBuiltins();

  const [connectProvider, setConnectProvider] = useState<SafeProvider | null>(null);
  const [disconnectConnection, setDisconnectConnection] = useState<SafeConnection | null>(null);
  const [updatingVisibility, setUpdatingVisibility] = useState<string | null>(null);
  const [installingBuiltin, setInstallingBuiltin] = useState<string | null>(null);

  // Handle OAuth callback redirect params
  useEffect(() => {
    if (searchParams.get('connected') === 'true') {
      toast.success('Integration connected successfully');
      mutateConnections();
      // Clean URL
      router.replace('/settings/integrations');
    } else if (searchParams.get('error')) {
      toast.error('Connection failed. Please try again.');
      router.replace('/settings/integrations');
    }
  }, [searchParams, mutateConnections, router]);

  const connectedProviderIds = useMemo(
    () => new Set(connections.map((c) => c.providerId)),
    [connections]
  );
  const availableProviders = useMemo(
    () => providers.filter((p) => !connectedProviderIds.has(p.id)),
    [providers, connectedProviderIds]
  );

  const handleDisconnect = async () => {
    if (!disconnectConnection) return;
    try {
      await del(`/api/user/integrations/${disconnectConnection.id}`);
      toast.success('Integration disconnected');
      mutateConnections();
    } catch {
      toast.error('Failed to disconnect integration');
    } finally {
      setDisconnectConnection(null);
    }
  };

  const handleVisibilityChange = async (connectionId: string, visibility: string) => {
    setUpdatingVisibility(connectionId);
    try {
      await patch(`/api/user/integrations/${connectionId}`, { visibility });
      mutateConnections();
    } catch {
      toast.error('Failed to update visibility');
    } finally {
      setUpdatingVisibility(null);
    }
  };

  const handleInstallBuiltin = async (builtinId: string) => {
    setInstallingBuiltin(builtinId);
    try {
      await post('/api/integrations/providers/install', { builtinId });
      toast.success('Integration installed');
      mutateProviders();
      mutateBuiltins();
    } catch {
      toast.error('Failed to install integration');
    } finally {
      setInstallingBuiltin(null);
    }
  };

  const isLoading = loadingProviders || loadingConnections;

  const getProviderDetailHref = (connection: SafeConnection) => {
    if (connection.provider?.slug === 'google-calendar') {
      return '/settings/integrations/google-calendar';
    }
    return null;
  };

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-2xl">
      <div className="mb-8">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold mb-2">Integrations</h1>
        <p className="text-muted-foreground">
          Connect external APIs and services to your AI assistants.
        </p>
      </div>

      <div className="space-y-6">
        {/* Connected Integrations */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cable className="h-5 w-5" />
              Connected
            </CardTitle>
            <CardDescription>
              Your active service connections.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : connectionsError ? (
              <div className="flex items-center gap-2 p-4 text-sm text-destructive bg-destructive/10 rounded-lg">
                <AlertCircle className="h-4 w-4" />
                <span>Failed to load integrations</span>
              </div>
            ) : connections.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No integrations connected yet.
              </p>
            ) : (
              <div className="space-y-3">
                {connections.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    detailHref={getProviderDetailHref(connection)}
                    updatingVisibility={updatingVisibility === connection.id}
                    onVisibilityChange={(v) => handleVisibilityChange(connection.id, v)}
                    onDetail={(href) => router.push(href)}
                    onDisconnect={() => setDisconnectConnection(connection)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Available Providers */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plug2 className="h-5 w-5" />
              Available Providers
            </CardTitle>
            <CardDescription>
              Connect new services to extend your AI assistants&apos; capabilities.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : providersError ? (
              <div className="flex items-center gap-2 p-4 text-sm text-destructive bg-destructive/10 rounded-lg">
                <AlertCircle className="h-4 w-4" />
                <span>Failed to load integrations</span>
              </div>
            ) : availableProviders.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <AlertCircle className="h-4 w-4" />
                {providers.length === 0
                  ? 'No integration providers configured.'
                  : 'All available providers are already connected.'}
              </div>
            ) : (
              <div className="space-y-3">
                {availableProviders.map((provider) => (
                  <div
                    key={provider.id}
                    className="flex items-center justify-between p-3 border rounded-lg bg-card"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-2 rounded-full bg-muted flex-shrink-0">
                        <Plug2 className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <span className="font-medium">{provider.name}</span>
                        {provider.description && (
                          <p className="text-xs text-muted-foreground truncate">
                            {provider.description}
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => setConnectProvider(provider)}
                    >
                      Connect
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Built-in Integrations */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Built-in Integrations
            </CardTitle>
            <CardDescription>
              Install built-in integrations to make them available for connection.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingBuiltins ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-full" />
              </div>
            ) : builtinsError ? (
              <div className="flex items-center gap-2 p-4 text-sm text-destructive bg-destructive/10 rounded-lg">
                <AlertCircle className="h-4 w-4" />
                <span>Failed to load available integrations</span>
              </div>
            ) : builtins.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                All built-in integrations have been installed.
              </p>
            ) : (
              <div className="space-y-3">
                {builtins.map((builtin) => (
                  <div
                    key={builtin.id}
                    className="flex items-center justify-between p-3 border rounded-lg bg-card"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-2 rounded-full bg-muted flex-shrink-0">
                        <Package className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <span className="font-medium">{builtin.name}</span>
                        {builtin.description && (
                          <p className="text-xs text-muted-foreground truncate">
                            {builtin.description}
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={installingBuiltin === builtin.id}
                      onClick={() => handleInstallBuiltin(builtin.id)}
                    >
                      {installingBuiltin === builtin.id ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : null}
                      Install
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Connect Dialog */}
      <ConnectIntegrationDialog
        provider={connectProvider}
        open={!!connectProvider}
        onOpenChange={(open) => { if (!open) setConnectProvider(null); }}
        onConnected={() => mutateConnections()}
      />

      {/* Disconnect Dialog with agent count */}
      <DisconnectWithAgentCount
        connection={disconnectConnection}
        onOpenChange={(open) => { if (!open) setDisconnectConnection(null); }}
        onConfirm={handleDisconnect}
      />
    </div>
  );
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function ConnectionRow({
  connection,
  detailHref,
  updatingVisibility,
  onVisibilityChange,
  onDetail,
  onDisconnect,
}: {
  connection: SafeConnection;
  detailHref: string | null;
  updatingVisibility: boolean;
  onVisibilityChange: (visibility: string) => void;
  onDetail: (href: string) => void;
  onDisconnect: () => void;
}) {
  const accountInfo = connection.accountMetadata;
  const accountLabel = accountInfo?.email || accountInfo?.accountName || accountInfo?.workspaceName;

  return (
    <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
      <div className="flex items-center gap-3 min-w-0">
        <div className="p-2 rounded-full bg-muted flex-shrink-0">
          <Plug2 className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{connection.name}</span>
            <IntegrationStatusBadge status={connection.status} />
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-1 flex-wrap">
            <span>{connection.provider?.name}</span>
            {accountLabel && (
              <> &middot; <span className="truncate max-w-[180px]">{accountLabel}</span></>
            )}
            {connection.visibility && (
              <> &middot; {visibilityLabels[connection.visibility] ?? connection.visibility}</>
            )}
            {connection.lastUsedAt && (
              <>
                {' '}&middot;{' '}
                <Clock className="h-3 w-3 inline" />
                <span>{formatRelativeTime(connection.lastUsedAt)}</span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {connection.visibility && (
          <Select
            value={connection.visibility}
            onValueChange={onVisibilityChange}
            disabled={updatingVisibility}
          >
            <SelectTrigger className="w-[130px] h-8 text-xs">
              {updatingVisibility ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <SelectValue />
              )}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="private">Private</SelectItem>
              <SelectItem value="owned_drives">Your drives</SelectItem>
              <SelectItem value="all_drives">All drives</SelectItem>
            </SelectContent>
          </Select>
        )}
        {detailHref && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${connection.name} details`}
            onClick={() => onDetail(detailHref)}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDisconnect}
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}

