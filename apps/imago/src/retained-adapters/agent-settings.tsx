'use client';

import { useRef, useState } from 'react';
import PageAgentSettingsTab, { type PageAgentSettingsTabRef } from '@/retained/components/ai/page-agents/PageAgentSettingsTab';
import type { AgentSettingsCategory } from '@/retained/components/ai/page-agents/AgentSettingsMenu';
import { useAgentConfig } from '@/retained/lib/ai/shared/hooks/useAgentConfig';
import { useProviderSettings } from '@/retained/lib/ai/shared/hooks/useProviderSettings';
import { usePermissions } from '@/retained/hooks/usePermissions';
import { Button } from '@/retained/components/ui/button';

/**
 * One category of an agent's settings, under the page's settings sub-nav. The sub-nav picks the
 * category; the form is the classic one. While the form has unsaved edits a sticky bar names the
 * category and offers Discard and Save.
 */
export function AgentSettings({
  pageId,
  driveId,
  category,
  categoryTitle,
}: {
  readonly pageId: string;
  readonly driveId: string;
  readonly category: AgentSettingsCategory;
  readonly categoryTitle: string;
}) {
  const { permissions } = usePermissions(pageId);
  const { config, setConfig, revalidate } = useAgentConfig(pageId);
  const provider = useProviderSettings({ pageId });
  const form = useRef<PageAgentSettingsTabRef>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const canEdit = permissions?.canEdit === true;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {canEdit ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PageAgentSettingsTab
            ref={form}
            pageId={pageId}
            driveId={driveId}
            category={category}
            config={config}
            onConfigUpdate={setConfig}
            onConfigRevalidate={revalidate}
            selectedProvider={provider.selectedProvider}
            selectedModel={provider.selectedModel}
            onProviderChange={provider.setSelectedProvider}
            onModelChange={provider.setSelectedModel}
            isProviderConfigured={provider.isProviderConfigured}
            onSavingChange={setSaving}
            onDirtyChange={setDirty}
          />
        </div>
      ) : (
        <p className="p-4 text-muted-foreground">Edit permission is required to configure this agent.</p>
      )}
      {canEdit && dirty && (
        <div
          role="region"
          aria-label="Unsaved changes"
          className="flex flex-none items-center gap-2.5 border-t bg-background/90 px-9 py-3 backdrop-blur"
        >
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-status-warning" />
          <span className="text-sm text-muted-foreground">Unsaved changes to {categoryTitle}</span>
          <div className="flex-1" />
          <Button variant="outline" size="sm" disabled={saving} onClick={() => form.current?.discardChanges()}>
            Discard
          </Button>
          <Button size="sm" disabled={saving || config === null} onClick={() => form.current?.submitForm()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  );
}
