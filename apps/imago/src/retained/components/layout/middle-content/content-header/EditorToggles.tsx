"use client";

import { Button } from '@/retained/components/ui/button';
import { useDocumentStore } from '@/retained/stores/useDocumentStore';
import { useMobile } from '@/retained/hooks/useMobile';
import { useDisplayPreferences } from '@/retained/hooks/useDisplayPreferences';

export function EditorToggles() {
  const activeView = useDocumentStore((state) => state.activeView);
  const setActiveView = useDocumentStore((state) => state.setActiveView);
  const isMobile = useMobile();
  const { preferences } = useDisplayPreferences();
  const shouldShowToggles = preferences.showCodeToggle;

  if (!shouldShowToggles || isMobile) {
    return null;
  }

  return (
    <div role="group" aria-label="Editor mode" className="flex items-center gap-2">
      <Button
        variant={activeView === 'rich' ? 'secondary' : 'ghost'}
        size="sm"
        aria-pressed={activeView === 'rich'}
        onClick={() => setActiveView('rich')}
      >
        Rich
      </Button>
      <Button
        variant={activeView === 'code' ? 'secondary' : 'ghost'}
        size="sm"
        aria-pressed={activeView === 'code'}
        onClick={() => setActiveView('code')}
      >
        Code
      </Button>
    </div>
  );
}
