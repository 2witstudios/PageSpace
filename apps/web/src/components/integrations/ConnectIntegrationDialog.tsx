'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { post } from '@/lib/auth/auth-fetch';
import type { SafeProvider } from './types';

interface ConnectIntegrationDialogProps {
  provider: SafeProvider | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
  scope?: 'user' | 'drive';
  driveId?: string;
}

export function ConnectIntegrationDialog({
  provider,
  open,
  onOpenChange,
  onConnected,
  scope = 'user',
  driveId,
}: ConnectIntegrationDialogProps) {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<string>('owned_drives');
  const [apiKey, setApiKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);

  const isOAuth = provider?.providerType === 'builtin';
  const requiresApiKey = !isOAuth;

  const handleConnect = async () => {
    if (!provider) return;
    setIsConnecting(true);

    try {
      const connectionName = name.trim() || provider.name;
      const endpoint = scope === 'drive' && driveId
        ? `/api/drives/${driveId}/integrations`
        : '/api/user/integrations';

      const body: Record<string, unknown> = {
        providerId: provider.id,
        name: connectionName,
        returnUrl: scope === 'drive' && driveId
          ? `/dashboard/${driveId}/settings`
          : '/settings/integrations',
      };

      if (scope === 'user') {
        body.visibility = visibility;
      }

      if (requiresApiKey && apiKey.trim()) {
        body.credentials = { apiKey: apiKey.trim() };
      }

      const result = await post<{ url?: string; connection?: { id: string } }>(endpoint, body);

      if (result.url) {
        window.location.href = result.url;
        return;
      }

      toast.success(`Connected to ${provider.name}`);
      onConnected();
      onOpenChange(false);
      resetForm();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to connect');
    } finally {
      setIsConnecting(false);
    }
  };

  const resetForm = () => {
    setName('');
    setVisibility('owned_drives');
    setApiKey('');
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resetForm(); onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {provider?.name}</DialogTitle>
          <DialogDescription>
            {isOAuth
              ? `You'll be redirected to ${provider?.name} to authorize access.`
              : `Enter your API credentials for ${provider?.name}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="connection-name">Connection Name</Label>
            <Input
              id="connection-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={provider?.name ?? 'My Connection'}
              maxLength={100}
            />
          </div>

          {scope === 'user' && (
            <div className="space-y-2">
              <Label htmlFor="visibility">Visibility</Label>
              <Select value={visibility} onValueChange={setVisibility}>
                <SelectTrigger id="visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private (only you)</SelectItem>
                  <SelectItem value="owned_drives">Your drives</SelectItem>
                  <SelectItem value="all_drives">All drives</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Controls which drives can use this connection.
              </p>
            </div>
          )}

          {requiresApiKey && (
            <div className="space-y-2">
              <Label htmlFor="api-key">API Key</Label>
              <Input
                id="api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter your API key"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleConnect}
            disabled={isConnecting || (requiresApiKey && !apiKey.trim())}
          >
            {isConnecting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Connecting...
              </>
            ) : isOAuth ? (
              'Authorize'
            ) : (
              'Connect'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
