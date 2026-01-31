"use client";

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useHotkeyPreferences, updateHotkeyPreference } from '@/hooks/useHotkeyPreferences';
import { HOTKEY_REGISTRY, HOTKEY_CATEGORIES, getHotkeysByCategory, type HotkeyCategory } from '@/lib/hotkeys/registry';
import { getEffectiveBinding } from '@/stores/useHotkeyStore';
import { HotkeyInput } from '@/components/settings/hotkeys/HotkeyInput';
import { toast } from 'sonner';

export default function HotkeysSettingsPage() {
  const router = useRouter();
  const { isLoading, mutate } = useHotkeyPreferences();
  const [editingId, setEditingId] = useState<string | null>(null);

  const hotkeysByCategory = getHotkeysByCategory();
  const categories = Object.keys(hotkeysByCategory) as HotkeyCategory[];

  function detectConflict(hotkeyId: string, newBinding: string): string | null {
    if (!newBinding) return null;

    for (const hotkey of HOTKEY_REGISTRY) {
      if (hotkey.id === hotkeyId) continue;
      const existingBinding = getEffectiveBinding(hotkey.id);
      if (existingBinding === newBinding) {
        return `Conflicts with "${hotkey.label}"`;
      }
    }
    return null;
  }

  const handleSave = async (hotkeyId: string, binding: string) => {
    const conflict = detectConflict(hotkeyId, binding);
    if (conflict) {
      toast.error(conflict);
      return;
    }

    try {
      await updateHotkeyPreference(hotkeyId, binding);
      setEditingId(null);
      toast.success('Hotkey updated');
      mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update hotkey');
    }
  };

  const handleReset = async (hotkeyId: string) => {
    const definition = HOTKEY_REGISTRY.find((h) => h.id === hotkeyId);
    if (definition) {
      await handleSave(hotkeyId, definition.defaultBinding);
    }
  };

  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-4xl">
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
        <h1 className="text-3xl font-bold mb-2">Keyboard Shortcuts</h1>
        <p className="text-muted-foreground">
          Customize keyboard shortcuts for common actions. Click a shortcut to edit it.
        </p>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground">Loading...</div>
      ) : (
        <div className="space-y-8">
          {categories.map((category) => {
            const hotkeys = hotkeysByCategory[category];
            if (hotkeys.length === 0) return null;

            const categoryInfo = HOTKEY_CATEGORIES[category];

            return (
              <Card key={category}>
                <CardHeader>
                  <CardTitle>{categoryInfo.label}</CardTitle>
                  <CardDescription>{categoryInfo.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {hotkeys.map((hotkey) => {
                      const effectiveBinding = getEffectiveBinding(hotkey.id);
                      const isEditing = editingId === hotkey.id;
                      const isCustomized = effectiveBinding !== hotkey.defaultBinding;

                      return (
                        <div
                          key={hotkey.id}
                          className="flex items-center justify-between py-2 border-b last:border-0"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="font-medium">{hotkey.label}</div>
                            <div className="text-sm text-muted-foreground truncate">
                              {hotkey.description}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 ml-4">
                            {isEditing ? (
                              <HotkeyInput
                                initialValue={effectiveBinding}
                                onSave={(binding) => handleSave(hotkey.id, binding)}
                                onCancel={() => setEditingId(null)}
                              />
                            ) : (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setEditingId(hotkey.id)}
                                  className="font-mono min-w-[120px]"
                                >
                                  {effectiveBinding || 'Disabled'}
                                </Button>
                                {isCustomized && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleReset(hotkey.id)}
                                    title="Reset to default"
                                  >
                                    <RotateCcw className="h-4 w-4" />
                                  </Button>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
