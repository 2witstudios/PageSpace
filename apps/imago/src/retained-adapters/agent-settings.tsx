'use client';

import { useRef, useState } from 'react';
import PageAgentSettingsTab, { type PageAgentSettingsTabRef } from '@/retained/components/ai/page-agents/PageAgentSettingsTab';
import { useAgentConfig } from '@/retained/lib/ai/shared/hooks/useAgentConfig';
import { useProviderSettings } from '@/retained/lib/ai/shared/hooks/useProviderSettings';
import { usePermissions } from '@/retained/hooks/usePermissions';
import { Button } from '@/retained/components/ui/button';
import { dispatch, transactions } from '@/ui/store/transactions';

export function AgentSettings({ pageId, driveId, title }: { pageId: string; driveId: string; title: string }) {
  const { permissions } = usePermissions(pageId);
  const { config, setConfig, revalidate } = useAgentConfig(pageId);
  const provider = useProviderSettings({ pageId });
  const form = useRef<PageAgentSettingsTabRef>(null);
  const [saving, setSaving] = useState(false);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b p-3">
        <Button variant="outline" onClick={() => dispatch(transactions.selectAgent, { id: pageId, title })}>Chat with {title}</Button>
        <Button disabled={saving || config === null || permissions?.canEdit !== true} onClick={() => form.current?.submitForm()}>{saving ? 'Saving…' : 'Save settings'}</Button>
      </div>
      {permissions?.canEdit === true ? <PageAgentSettingsTab ref={form} pageId={pageId} driveId={driveId} config={config}
        onConfigUpdate={setConfig} onConfigRevalidate={revalidate}
        selectedProvider={provider.selectedProvider} selectedModel={provider.selectedModel}
        onProviderChange={provider.setSelectedProvider} onModelChange={provider.setSelectedModel}
        isProviderConfigured={provider.isProviderConfigured} onSavingChange={setSaving} /> : <p className="p-4 text-muted-foreground">Edit permission is required to configure this agent.</p>}
    </div>
  );
}
