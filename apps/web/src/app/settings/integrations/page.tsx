'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Cable, Plug2, Loader2, ExternalLink, AlertCircle, Package } from 'lucide-react';
import { toast } from 'sonner';
import { useProviders, useUserConnections, useAvailableBuiltins } from '@/hooks/useIntegrations';
import { IntegrationStatusBadge } from '@/components/integrations/IntegrationStatusBadge';
import { ConnectIntegrationDialog } from '@/components/integrations/ConnectIntegrationDialog';
import { DisconnectConfirmDialog } from '@/components/integrations/DisconnectConfirmDialog';
import { del, post } from '@/lib/auth/auth-fetch';
import { SettingsPageLayout } from '@/components/settings/SettingsPageLayout';
import { SettingsSection } from '@/components/settings/SettingsSection';
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
  const [installingBuiltin, setInstallingBuiltin] = useState<string | null>(null);

  useEffect(() => {
    if (searchParams.get('connected') === 'true') {
      toast.success('Integration connected successfully');
      mutateConnections();
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

  const renderConnectionItem = (connection: SafeConnection) => {
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
          {detailHref && (
            <Button variant="ghost" size="sm" onClick={() => router.push(detailHref)}>
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
  };

  const renderProviderItem = (provider: SafeProvider) => (
    <div key={provider.id} className="flex items-center justify-between p-3 border rounded-lg bg-card">
      <div className="flex items-center gap-3 min-w-0">
        <div className="p-2 rounded-full bg-muted flex-shrink-0">
          <Plug2 className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <span className="font-medium">{provider.name}</span>
          {provider.description && (
            <p className="text-xs text-muted-foreground truncate">{provider.description}</p>
          )}
        </div>
      </div>
      <Button size="sm" onClick={() => setConnectProvider(provider)}>Connect</Button>
    </div>
  );

  const renderBuiltinItem = (builtin: { id: string; name: string; description?: string }) => (
    <div key={builtin.id} className="flex items-center justify-between p-3 border rounded-lg bg-card">
      <div className="flex items-center gap-3 min-w-0">
        <div className="p-2 rounded-full bg-muted flex-shrink-0">
          <Package className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <span className="font-medium">{builtin.name}</span>
          {builtin.description && (
            <p className="text-xs text-muted-foreground truncate">{builtin.description}</p>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={installingBuiltin === builtin.id}
        onClick={() => handleInstallBuiltin(builtin.id)}
      >
        {installingBuiltin === builtin.id ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
        Install
      </Button>
    </div>
  );

  const renderLoading = (count = 2) => (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );

  const renderError = (message: string) => (
    <div className="flex items-center gap-2 p-4 text-sm text-destructive bg-destructive/10 rounded-lg">
      <AlertCircle className="h-4 w-4" />
      <span>{message}</span>
    </div>
  );

  return (
    <SettingsPageLayout
      title="Integrations"
      description="Connect external APIs and services to your AI assistants"
      icon={Cable}
    >
      <SettingsSection title="Connected" icon={Cable} description="Your active service connections.">
        {isLoading ? renderLoading() : connectionsError ? renderError('Failed to load integrations') : connections.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No integrations connected yet.</p>
        ) : (
          <div className="space-y-3">{connections.map(renderConnectionItem)}</div>
        )}
      </SettingsSection>

      <SettingsSection title="Available Providers" icon={Plug2} description="Connect new services to extend your AI assistants' capabilities.">
        {isLoading ? renderLoading() : providersError ? renderError('Failed to load integrations') : availableProviders.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <AlertCircle className="h-4 w-4" />
            {providers.length === 0 ? 'No integration providers configured.' : 'All available providers are already connected.'}
          </div>
        ) : (
          <div className="space-y-3">{availableProviders.map(renderProviderItem)}</div>
        )}
      </SettingsSection>

      <SettingsSection title="Built-in Integrations" icon={Package} description="Install built-in integrations to make them available for connection.">
        {loadingBuiltins ? renderLoading(1) : builtinsError ? renderError('Failed to load available integrations') : builtins.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">All built-in integrations have been installed.</p>
        ) : (
          <div className="space-y-3">{builtins.map(renderBuiltinItem)}</div>
        )}
      </SettingsSection>

      <ConnectIntegrationDialog
        provider={connectProvider}
        open={!!connectProvider}
        onOpenChange={(open) => { if (!open) setConnectProvider(null); }}
        onConnected={() => mutateConnections()}
      />

      <DisconnectConfirmDialog
        open={!!disconnectConnection}
        onOpenChange={(open) => { if (!open) setDisconnectConnection(null); }}
        connectionName={disconnectConnection?.name ?? ''}
        onConfirm={handleDisconnect}
      />
    </SettingsPageLayout>
  );
}
