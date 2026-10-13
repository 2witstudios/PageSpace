'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from '@/retained-adapters/navigation';
import { useSWRConfig } from 'swr';
import { Button } from '@/retained/components/ui/button';
import { Badge } from '@/retained/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/retained/components/ui/select';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Loader2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/retained/hooks/useAuth';
import { useProviders, useUserConnections, useAvailableBuiltins, useGoogleCalendarStatus } from '@/retained/hooks/useIntegrations';
import { ConnectIntegrationDialog } from '@/retained/components/integrations/ConnectIntegrationDialog';
import { DisconnectWithAgentCount } from '@/retained/components/integrations/DisconnectConfirmDialog';
import { del, patch, post } from '@/retained/lib/auth/auth-fetch';
import type { SafeProvider, SafeConnection, ConnectionStatus } from '@/retained/components/integrations/types';
import {
  SettingsGroup,
  SettingsRow,
  SettingsScreen,
  SettingsSection,
} from '@/ui/settings/settings-screen/settings-screen';

const visibilityLabels: Record<string, string> = {
  private: 'Private',
  owned_drives: 'Your drives',
  all_drives: 'All drives',
};

const statusLabels: Record<ConnectionStatus, string> = {
  active: 'Active',
  pending: 'Pending',
  expired: 'Expired',
  error: 'Error',
  revoked: 'Revoked',
};

const statusVariants: Partial<Record<ConnectionStatus, 'default' | 'secondary' | 'destructive' | 'outline'>> = {
  active: 'default',
  pending: 'secondary',
  expired: 'destructive',
  error: 'destructive',
  revoked: 'outline',
};

const GCAL_STATUS_URL = '/api/integrations/google-calendar/status';

function googleCalendarStatusLabel(status: string): string {
  if (status === 'active') return 'Active';
  if (status === 'expired') return 'Expired';
  if (status === 'error') return 'Error';
  return 'Disconnected';
}

export default function IntegrationsSettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { mutate: mutateSWR } = useSWRConfig();
  const isAdmin = user?.role === 'admin';
  const { providers, isLoading: loadingProviders, error: providersError, mutate: mutateProviders } = useProviders();
  const { connections, isLoading: loadingConnections, error: connectionsError, mutate: mutateConnections } = useUserConnections();

  const { builtins, isLoading: loadingBuiltins, error: builtinsError, mutate: mutateBuiltins } = useAvailableBuiltins();
  const { connection: gcalConnection, error: gcalError, isLoading: gcalLoading } = useGoogleCalendarStatus();

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
    () => providers.filter((p) => !connectedProviderIds.has(p.id) && (isAdmin || p.slug === 'github')),
    [providers, connectedProviderIds, isAdmin]
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

  const handleDisconnectGoogleCalendar = async () => {
    try {
      await post('/api/integrations/google-calendar/disconnect');
      toast.success('Google Calendar disconnected');
      void mutateSWR(GCAL_STATUS_URL);
    } catch {
      toast.error('Failed to disconnect Google Calendar');
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
  const showGoogleCalendar = gcalConnection !== null;
  const connectedCount = connections.length + (showGoogleCalendar ? 1 : 0);

  return (
    <SettingsScreen title="Integrations" lede="Connect external services so your agents can act on them.">
      <div className="grid grid-cols-3 gap-4 text-xs text-muted-foreground">
        <p>
          <span className="block font-medium text-foreground">Connection</span>
          Sign in once. Agents act under your account on that service.
        </p>
        <p>
          <span className="block font-medium text-foreground">Visibility</span>
          Choose which drives may use the connection.
        </p>
        <p>
          <span className="block font-medium text-foreground">Per-agent tools</span>
          Each AI chat picks exactly which tools it may use.
        </p>
      </div>

      <SettingsSection title={`Connected ${connectedCount}`}>
        {isLoading || gcalLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : connectionsError ? (
          <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            <span>Failed to load integrations</span>
          </div>
        ) : connectedCount === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No integrations connected yet.</p>
        ) : (
          <SettingsGroup>
            {showGoogleCalendar && gcalConnection && (
              <SettingsRow
                label={
                  <span className="flex items-center gap-2">
                    Google Calendar
                    <Badge variant="outline">{googleCalendarStatusLabel(gcalConnection.status)}</Badge>
                  </span>
                }
                hint={`${gcalConnection.googleEmail} · two-way sync`}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Manage Google Calendar"
                  onClick={() => router.push('/settings/integrations/google-calendar')}
                >
                  Manage
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  aria-label="Disconnect Google Calendar"
                  onClick={() => void handleDisconnectGoogleCalendar()}
                >
                  Disconnect
                </Button>
              </SettingsRow>
            )}
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                updatingVisibility={updatingVisibility === connection.id}
                onReconnect={() => {
                  const provider = providers.find((p) => p.id === connection.providerId);
                  if (provider) setConnectProvider(provider);
                }}
                onVisibilityChange={(v) => handleVisibilityChange(connection.id, v)}
                onDisconnect={() => setDisconnectConnection(connection)}
              />
            ))}
          </SettingsGroup>
        )}
        {gcalError && <p className="text-xs text-destructive">Failed to load Google Calendar status</p>}
      </SettingsSection>

      <SettingsSection title="Available providers">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
          </div>
        ) : providersError ? (
          <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            <span>Failed to load integrations</span>
          </div>
        ) : availableProviders.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4" />
            {providers.length === 0
              ? 'No integration providers configured.'
              : 'All available providers are already connected.'}
          </div>
        ) : (
          <SettingsGroup>
            {availableProviders.map((provider) => (
              <SettingsRow key={provider.id} label={provider.name} hint={provider.description ?? undefined}>
                <Button size="sm" onClick={() => setConnectProvider(provider)}>
                  Connect
                </Button>
              </SettingsRow>
            ))}
          </SettingsGroup>
        )}
      </SettingsSection>

      {isAdmin && (
        <SettingsSection
          title="Built-in integrations"
          description="Install a built-in so it appears under Available providers for everyone."
          actions={<Badge variant="secondary">Admin</Badge>}
        >
          {loadingBuiltins ? (
            <Skeleton className="h-14 w-full" />
          ) : builtinsError ? (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>Failed to load available integrations</span>
            </div>
          ) : builtins.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">All built-in integrations have been installed.</p>
          ) : (
            <SettingsGroup>
              {builtins.map((builtin) => (
                <SettingsRow key={builtin.id} label={builtin.name} hint={builtin.description ?? undefined}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={installingBuiltin === builtin.id}
                    onClick={() => handleInstallBuiltin(builtin.id)}
                  >
                    {installingBuiltin === builtin.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                    Install
                  </Button>
                </SettingsRow>
              ))}
            </SettingsGroup>
          )}
        </SettingsSection>
      )}

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
    </SettingsScreen>
  );
}

function ConnectionRow({
  connection,
  updatingVisibility,
  onReconnect,
  onVisibilityChange,
  onDisconnect,
}: {
  connection: SafeConnection;
  updatingVisibility: boolean;
  onReconnect: () => void;
  onVisibilityChange: (visibility: string) => void;
  onDisconnect: () => void;
}) {
  const accountInfo = connection.accountMetadata;
  const accountLabel = accountInfo?.email || accountInfo?.accountName || accountInfo?.workspaceName;
  const name = connection.name;
  const expired = connection.status === 'expired';

  return (
    <SettingsRow
      label={
        <span className="flex items-center gap-2">
          {name}
          <Badge variant={statusVariants[connection.status] ?? 'outline'}>
            {statusLabels[connection.status] ?? connection.status}
          </Badge>
        </span>
      }
      hint={accountLabel ?? connection.provider?.name}
    >
      {connection.visibility && (
        <Select
          value={connection.visibility}
          onValueChange={onVisibilityChange}
          disabled={updatingVisibility}
        >
          <SelectTrigger aria-label={`Visibility for ${name}`} className="h-8 w-[130px] text-xs">
            {updatingVisibility ? <Loader2 className="h-3 w-3 animate-spin" /> : <SelectValue />}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="private">{visibilityLabels.private}</SelectItem>
            <SelectItem value="owned_drives">{visibilityLabels.owned_drives}</SelectItem>
            <SelectItem value="all_drives">{visibilityLabels.all_drives}</SelectItem>
          </SelectContent>
        </Select>
      )}
      {expired && (
        <Button variant="outline" size="sm" aria-label={`Reconnect ${name}`} onClick={onReconnect}>
          Reconnect
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        aria-label={`Disconnect ${name}`}
        onClick={onDisconnect}
      >
        Disconnect
      </Button>
    </SettingsRow>
  );
}
