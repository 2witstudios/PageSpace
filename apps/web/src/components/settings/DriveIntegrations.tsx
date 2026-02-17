'use client';

import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, Cable, Plug2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useDriveConnections, useProviders } from '@/hooks/useIntegrations';
import { IntegrationStatusBadge } from '@/components/integrations/IntegrationStatusBadge';
import { ConnectIntegrationDialog } from '@/components/integrations/ConnectIntegrationDialog';
import { DisconnectConfirmDialog } from '@/components/integrations/DisconnectConfirmDialog';
import { del } from '@/lib/auth/auth-fetch';
import type { SafeProvider, SafeConnection } from '@/components/integrations/types';

interface DriveIntegrationsProps {
  driveId: string;
}

export function DriveIntegrations({ driveId }: DriveIntegrationsProps) {
  const { connections, isLoading: loadingConnections, error: connectionsError, mutate: mutateConnections } = useDriveConnections(driveId);
  const { providers, isLoading: loadingProviders, error: providersError } = useProviders();

  const [connectProvider, setConnectProvider] = useState<SafeProvider | null>(null);
  const [disconnectConnection, setDisconnectConnection] = useState<SafeConnection | null>(null);
  const [showProviderPicker, setShowProviderPicker] = useState(false);

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
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Cable className="w-5 h-5" />
                Drive Integrations
              </CardTitle>
              <CardDescription>
                External services connected to this drive. Available to all AI agents in this drive.
              </CardDescription>
            </div>
            <Button
              size="sm"
              onClick={() => setShowProviderPicker(true)}
              disabled={isLoading || availableProviders.length === 0}
            >
              <Plus className="h-4 w-4 mr-1" />
              Connect
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 p-4 text-sm text-destructive bg-destructive/10 rounded-lg">
              <AlertCircle className="h-4 w-4" />
              <span>Failed to load integrations</span>
              <Button variant="ghost" size="sm" onClick={() => mutateConnections()}>
                Retry
              </Button>
            </div>
          ) : connections.length === 0 ? (
            <div className="border border-dashed rounded-lg p-6 text-center">
              <Plug2 className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No integrations connected to this drive.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {connections.map((connection) => (
                <div
                  key={connection.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
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
                      {connection.provider && (
                        <p className="text-xs text-muted-foreground">{connection.provider.name}</p>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDisconnectConnection(connection)}
                  >
                    Disconnect
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

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

      <DisconnectConfirmDialog
        open={!!disconnectConnection}
        onOpenChange={(open) => { if (!open) setDisconnectConnection(null); }}
        connectionName={disconnectConnection?.name ?? ''}
        onConfirm={handleDisconnect}
      />
    </>
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
