"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR, { mutate } from "swr";
import { ArrowLeft, ExternalLink, Check, X, Loader2, Trash2, RefreshCw, Globe, Blocks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { post, del, patch } from "@/lib/fetch";

// Type for integration status from API
interface IntegrationTool {
  name: string;
  displayName: string;
  description: string;
  isWriteTool?: boolean;
  tags?: string[];
}

interface IntegrationDefinition {
  id: string;
  name: string;
  description: string;
  tagline: string;
  icon: string;
  category: string;
  docsUrl?: string;
  requiresApiKey: boolean;
  apiKeyLabel?: string;
  apiKeyDescription?: string;
  tools: IntegrationTool[];
}

interface UserConfig {
  id: string;
  enabled: boolean;
  hasApiKey: boolean;
  validationStatus?: string;
  validationMessage?: string;
  enabledTools?: string[] | null;
}

interface IntegrationStatus {
  definition: IntegrationDefinition;
  userConfig?: UserConfig;
  isConfigured: boolean;
  isEnabled: boolean;
  availableTools: IntegrationTool[];
  enabledTools: IntegrationTool[];
}

interface IntegrationsResponse {
  integrations: IntegrationStatus[];
  configuredCount: number;
  enabledCount: number;
}

const fetcher = (url: string) => fetch(url, { credentials: 'include' }).then(r => r.json());

// Icon mapping from string to component
const iconMap: Record<string, React.ReactNode> = {
  Globe: <Globe className="h-6 w-6" />,
  Blocks: <Blocks className="h-6 w-6" />,
};

function getIcon(iconName: string): React.ReactNode {
  return iconMap[iconName] || <Blocks className="h-6 w-6" />;
}

export default function IntegrationsPage() {
  const router = useRouter();
  const { data, error, isLoading } = useSWR<IntegrationsResponse>(
    '/api/settings/integrations',
    fetcher
  );

  const [configureOpen, setConfigureOpen] = useState(false);
  const [selectedIntegration, setSelectedIntegration] = useState<IntegrationStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [integrationToDelete, setIntegrationToDelete] = useState<IntegrationStatus | null>(null);

  const handleConfigure = (integration: IntegrationStatus) => {
    setSelectedIntegration(integration);
    setApiKey("");
    setConfigureOpen(true);
  };

  const handleSave = async () => {
    if (!selectedIntegration) return;

    setIsSaving(true);
    try {
      if (selectedIntegration.isConfigured) {
        // Update existing configuration
        await patch(`/api/settings/integrations/${selectedIntegration.definition.id}`, {
          apiKey: apiKey || undefined,
        });
        toast.success(`${selectedIntegration.definition.name} updated`);
      } else {
        // Create new configuration
        await post('/api/settings/integrations', {
          integrationId: selectedIntegration.definition.id,
          apiKey,
        });
        toast.success(`${selectedIntegration.definition.name} configured`);
      }

      mutate('/api/settings/integrations');
      setConfigureOpen(false);
      setApiKey("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save integration');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleEnabled = async (integration: IntegrationStatus, enabled: boolean) => {
    try {
      await patch(`/api/settings/integrations/${integration.definition.id}`, {
        enabled,
      });
      mutate('/api/settings/integrations');
      toast.success(`${integration.definition.name} ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update integration');
    }
  };

  const handleValidate = async (integration: IntegrationStatus) => {
    setIsValidating(true);
    try {
      const response = await post(`/api/settings/integrations/${integration.definition.id}`, {});
      mutate('/api/settings/integrations');
      if (response.success) {
        toast.success(response.validationMessage || 'Credentials validated');
      } else {
        toast.error(response.validationMessage || 'Validation failed');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Validation failed');
    } finally {
      setIsValidating(false);
    }
  };

  const handleDelete = async () => {
    if (!integrationToDelete) return;

    try {
      await del(`/api/settings/integrations/${integrationToDelete.definition.id}`);
      mutate('/api/settings/integrations');
      toast.success(`${integrationToDelete.definition.name} removed`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove integration');
    } finally {
      setDeleteDialogOpen(false);
      setIntegrationToDelete(null);
    }
  };

  if (error) {
    return (
      <div className="container mx-auto px-4 py-10">
        <p className="text-destructive">Failed to load integrations</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10">
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
          Connect third-party services to extend AI capabilities with additional tools
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data?.integrations.map((integration) => (
            <Card key={integration.definition.id} className="relative">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-muted rounded-lg">
                      {getIcon(integration.definition.icon)}
                    </div>
                    <div>
                      <CardTitle className="text-lg">{integration.definition.name}</CardTitle>
                      <CardDescription className="text-sm">
                        {integration.definition.tagline}
                      </CardDescription>
                    </div>
                  </div>
                  {integration.isConfigured && (
                    <Switch
                      checked={integration.isEnabled}
                      onCheckedChange={(checked) => handleToggleEnabled(integration, checked)}
                    />
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  {integration.definition.description}
                </p>

                {/* Status badges */}
                <div className="flex flex-wrap gap-2 mb-4">
                  {integration.isConfigured ? (
                    <>
                      {integration.userConfig?.validationStatus === 'valid' ? (
                        <Badge variant="outline" className="text-green-600 border-green-600">
                          <Check className="h-3 w-3 mr-1" />
                          Connected
                        </Badge>
                      ) : integration.userConfig?.validationStatus === 'invalid' ? (
                        <Badge variant="outline" className="text-red-600 border-red-600">
                          <X className="h-3 w-3 mr-1" />
                          Invalid
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-yellow-600 border-yellow-600">
                          Unknown Status
                        </Badge>
                      )}
                      <Badge variant="secondary">
                        {integration.enabledTools.length} tools
                      </Badge>
                    </>
                  ) : (
                    <Badge variant="outline">Not configured</Badge>
                  )}
                </div>

                {/* Tools list */}
                {integration.isConfigured && integration.isEnabled && integration.enabledTools.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs text-muted-foreground mb-2">Available tools:</p>
                    <div className="flex flex-wrap gap-1">
                      {integration.enabledTools.slice(0, 3).map((tool) => (
                        <Badge key={tool.name} variant="secondary" className="text-xs">
                          {tool.displayName}
                        </Badge>
                      ))}
                      {integration.enabledTools.length > 3 && (
                        <Badge variant="secondary" className="text-xs">
                          +{integration.enabledTools.length - 3} more
                        </Badge>
                      )}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-2">
                  <Button
                    variant={integration.isConfigured ? "outline" : "default"}
                    size="sm"
                    onClick={() => handleConfigure(integration)}
                  >
                    {integration.isConfigured ? "Update" : "Configure"}
                  </Button>
                  {integration.isConfigured && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleValidate(integration)}
                        disabled={isValidating}
                      >
                        {isValidating ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setIntegrationToDelete(integration);
                          setDeleteDialogOpen(true);
                        }}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                  {integration.definition.docsUrl && (
                    <Button
                      variant="ghost"
                      size="sm"
                      asChild
                    >
                      <a href={integration.definition.docsUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Configure Dialog */}
      <Dialog open={configureOpen} onOpenChange={setConfigureOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {selectedIntegration?.isConfigured ? 'Update' : 'Configure'} {selectedIntegration?.definition.name}
            </DialogTitle>
            <DialogDescription>
              {selectedIntegration?.definition.apiKeyDescription ||
                `Enter your ${selectedIntegration?.definition.apiKeyLabel || 'API Key'} to connect ${selectedIntegration?.definition.name}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="apiKey">
                {selectedIntegration?.definition.apiKeyLabel || 'API Key'}
              </Label>
              <Input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={selectedIntegration?.isConfigured ? '••••••••••••' : 'Enter API key'}
              />
              {selectedIntegration?.isConfigured && (
                <p className="text-xs text-muted-foreground">
                  Leave empty to keep the current API key
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfigureOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={isSaving || (!selectedIntegration?.isConfigured && !apiKey)}
            >
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {selectedIntegration?.isConfigured ? 'Update' : 'Connect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Integration</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove {integrationToDelete?.definition.name}? This will delete
              your API key and disable all tools from this integration.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
