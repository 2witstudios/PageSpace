"use client";

import { Button } from '@/components/ui/button';
import { useDocumentStore } from '@/stores/useDocumentStore';
import { useMobile } from '@/hooks/useMobile';
import { useDisplayPreferences } from '@/hooks/useDisplayPreferences';

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
    <div className="flex items-center gap-2">
      <Button
        variant={activeView === 'rich' ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setActiveView('rich')}
      >
        Rich
      </Button>
      <Button
        variant={activeView === 'code' ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setActiveView('code')}
      >
        Code
      </Button>
    </div>
  );
}
