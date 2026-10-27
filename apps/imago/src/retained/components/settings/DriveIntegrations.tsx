'use client';

import { useState, useMemo } from 'react';
import { Button } from '@/retained/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/retained/components/ui/dialog';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { AlertCircle, Plug2, Plus } from 'lucide-react';
import { SettingsSection, SettingsGroup } from '@/ui/settings/settings-screen/settings-screen';
import { toast } from 'sonner';
import { useAuth } from '@/retained/hooks/useAuth';
import { useDriveConnections, useProviders, useConnectionGrantCount } from '@/retained/hooks/useIntegrations';
import { IntegrationStatusBadge } from '@/retained/components/integrations/IntegrationStatusBadge';
import { ConnectIntegrationDialog } from '@/retained/components/integrations/ConnectIntegrationDialog';
import { DisconnectWithAgentCount } from '@/retained/components/integrations/DisconnectConfirmDialog';
import { del } from '@/retained/lib/auth/auth-fetch';
import type { SafeProvider, SafeConnection } from '@/retained/components/integrations/types';

interface DriveIntegrationsProps {
  driveId: string;
}

export function DriveIntegrations({ driveId }: DriveIntegrationsProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { connections, isLoading: loadingConnections, error: connectionsError, mutate: mutateConnections } = useDriveConnections(driveId);
  const { providers, isLoading: loadingProviders, error: providersError, mutate: mutateProviders } = useProviders();

  const [connectProvider, setConnectProvider] = useState<SafeProvider | null>(null);
  const [disconnectConnection, setDisconnectConnection] = useState<SafeConnection | null>(null);
  const [showProviderPicker, setShowProviderPicker] = useState(false);

  const connectedProviderIds = useMemo(
    () => new Set(connections.map((c) => c.providerId)),
    [connections]
  );
  const availableProviders = useMemo(
    () => providers.filter((p) => !connectedProviderIds.has(p.id) && (isAdmin || p.slug === 'github')),
    [providers, connectedProviderIds, isAdmin]
  );

  const handleDisconnect = async () => {
    if (!disconnectConnection) return;
    try {
      await del(`/api/drives/${driveId}/integrations/${disconnectConnection.id}`);
      toast.success('Integration disconnected from drive');
      mutateConnections();
    } catch {
      toast.error('Failed to disconnect integration');
    } finally {
      setDisconnectConnection(null);
    }
  };

  const isLoading = loadingConnections || loadingProviders;
  const error = connectionsError || providersError;

  return (
    <>
      <SettingsSection
        title="Connected"
        actions={
          <Button
            size="sm"
            onClick={() => setShowProviderPicker(true)}
            disabled={isLoading || availableProviders.length === 0}
          >
            <Plus className="h-4 w-4 mr-1" />
            Connect
          </Button>
        }
      >
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 p-4 text-sm text-destructive bg-destructive/10 rounded-lg">
            <AlertCircle className="h-4 w-4" />
            <span>Failed to load integrations</span>
            <Button variant="ghost" size="sm" onClick={() => { mutateConnections(); mutateProviders(); }}>
              Retry
            </Button>
          </div>
        ) : connections.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center">
            <Plug2 className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No integrations connected to this drive.</p>
          </div>
        ) : (
          <SettingsGroup label="Connected integrations">
            {connections.map((connection) => (
              <DriveConnectionRow
                key={connection.id}
                connection={connection}
                onDisconnect={() => setDisconnectConnection(connection)}
              />
            ))}
          </SettingsGroup>
        )}
      </SettingsSection>

      {/* Provider Picker - reuse ConnectIntegrationDialog for the selected provider */}
      {showProviderPicker && !connectProvider && (
        <ProviderPickerDialog
          providers={availableProviders}
          open={showProviderPicker}
          onOpenChange={setShowProviderPicker}
          onSelect={(provider) => {
            setShowProviderPicker(false);
            setConnectProvider(provider);
          }}
        />
      )}

      <ConnectIntegrationDialog
        provider={connectProvider}
        open={!!connectProvider}
        onOpenChange={(open) => { if (!open) setConnectProvider(null); }}
        onConnected={() => mutateConnections()}
        scope="drive"
        driveId={driveId}
      />

      <DisconnectWithAgentCount
        connection={disconnectConnection}
        onOpenChange={(open) => { if (!open) setDisconnectConnection(null); }}
        onConfirm={handleDisconnect}
      />
    </>
  );
}

function DriveConnectionRow({
  connection,
  onDisconnect,
}: {
  connection: SafeConnection;
  onDisconnect: () => void;
}) {
  const { count: agentCount, isLoading: loadingGrants } = useConnectionGrantCount(connection.id);
  const providerName = connection.provider?.name;

  return (
    <div className="flex min-h-[60px] items-center gap-3 px-4 py-2">
      <span
        aria-hidden="true"
        className="grid size-9 flex-none place-items-center rounded-[10px] bg-tint text-sm font-bold text-muted-foreground"
      >
        {(providerName ?? connection.name).slice(0, 2)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-foreground">{connection.name}</span>
          <IntegrationStatusBadge status={connection.status} />
        </div>
        <div className="text-xs text-muted-foreground">
          {providerName ?? 'Unknown provider'}
          {loadingGrants ? null : ` · ${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={onDisconnect}
      >
        Disconnect
      </Button>
    </div>
  );
}

function ProviderPickerDialog({
  providers,
  open,
  onOpenChange,
  onSelect,
}: {
  providers: SafeProvider[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (provider: SafeProvider) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Integration</DialogTitle>
          <DialogDescription>
            Choose a service to connect to this drive.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No providers available.
            </p>
          ) : (
            providers.map((provider) => (
              <Button
                key={provider.id}
                variant="ghost"
                className="flex items-center gap-3 w-full p-3 h-auto justify-start border rounded-lg hover:bg-accent text-left"
                onClick={() => onSelect(provider)}
              >
                <div className="p-2 rounded-full bg-muted">
                  <Plug2 className="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <span className="font-medium">{provider.name}</span>
                  {provider.description && (
                    <p className="text-xs text-muted-foreground">{provider.description}</p>
                  )}
                </div>
              </Button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
