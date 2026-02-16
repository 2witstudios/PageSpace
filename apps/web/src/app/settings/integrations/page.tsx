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
import { ArrowLeft, Cable, Plug2, Loader2, ExternalLink, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useProviders, useUserConnections } from '@/hooks/useIntegrations';
import { IntegrationStatusBadge } from '@/components/integrations/IntegrationStatusBadge';
import { ConnectIntegrationDialog } from '@/components/integrations/ConnectIntegrationDialog';
import { DisconnectConfirmDialog } from '@/components/integrations/DisconnectConfirmDialog';
import { del, patch } from '@/lib/auth/auth-fetch';
import type { SafeProvider, SafeConnection } from '@/components/integrations/types';

const visibilityLabels: Record<string, string> = {
  private: 'Private',
  owned_drives: 'Your drives',
  all_drives: 'All drives',
};

export default function IntegrationsSettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { providers, isLoading: loadingProviders } = useProviders();
  const { connections, isLoading: loadingConnections, mutate: mutateConnections } = useUserConnections();

  const [connectProvider, setConnectProvider] = useState<SafeProvider | null>(null);
  const [disconnectConnection, setDisconnectConnection] = useState<SafeConnection | null>(null);
  const [updatingVisibility, setUpdatingVisibility] = useState<string | null>(null);

  // Handle OAuth callback redirect params
  useEffect(() => {
    if (searchParams.get('connected') === 'true') {
      toast.success('Integration connected successfully');
      mutateConnections();
      // Clean URL
      router.replace('/settings/integrations');
    } else if (searchParams.get('error')) {
      toast.error(`Connection failed: ${searchParams.get('error')}`);
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
            ) : connections.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No integrations connected yet.
              </p>
            ) : (
              <div className="space-y-3">
                {connections.map((connection) => {
                  const detailHref = getProviderDetailHref(connection);
                  return (
                    <div
                      key={connection.id}
                      className="flex items-center justify-between p-3 border rounded-lg bg-card"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-2 rounded-full bg-muted flex-shrink-0">
                          <Plug2 className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{connection.name}</span>
                            <IntegrationStatusBadge status={connection.status} />
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {connection.provider?.name}
                            {connection.visibility && (
                              <> &middot; {visibilityLabels[connection.visibility] ?? connection.visibility}</>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {connection.visibility && (
                          <Select
                            value={connection.visibility}
                            onValueChange={(v) => handleVisibilityChange(connection.id, v)}
                            disabled={updatingVisibility === connection.id}
                          >
                            <SelectTrigger className="w-[130px] h-8 text-xs">
                              {updatingVisibility === connection.id ? (
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
                            onClick={() => router.push(detailHref)}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDisconnectConnection(connection)}
                        >
                          Disconnect
                        </Button>
                      </div>
                    </div>
                  );
                })}
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
      </div>

      {/* Connect Dialog */}
      <ConnectIntegrationDialog
        provider={connectProvider}
        open={!!connectProvider}
        onOpenChange={(open) => { if (!open) setConnectProvider(null); }}
        onConnected={() => mutateConnections()}
      />

      {/* Disconnect Dialog */}
      <DisconnectConfirmDialog
        open={!!disconnectConnection}
        onOpenChange={(open) => { if (!open) setDisconnectConnection(null); }}
        connectionName={disconnectConnection?.name ?? ''}
        onConfirm={handleDisconnect}
      />
    </div>
  );
}
