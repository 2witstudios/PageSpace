"use client";

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useHotkeyPreferences,
  updateHotkeyPreference,
  deleteHotkeyPreference,
  fetchHotkeyPreferences,
  unusablePreferences,
} from '@/hooks/useHotkeyPreferences';
import { HOTKEY_REGISTRY, HOTKEY_CATEGORIES, getHotkeysByCategory, type HotkeyCategory } from '@/lib/hotkeys/registry';
import { getEffectiveBinding, resolvePlatformBinding, useHotkeyStore } from '@/stores/useHotkeyStore';
import { HotkeyInput } from '@/components/settings/hotkeys/HotkeyInput';
import { RESERVED_BINDINGS, formatBindingForDisplay } from '@/lib/hotkeys/binding';
import { useIsMac } from '@/hooks/useIsMac';
import { toast } from 'sonner';

export default function HotkeysSettingsPage() {
  const router = useRouter();
  const { preferences, isLoading, mutate } = useHotkeyPreferences();
  const userBindings = useHotkeyStore((s) => s.userBindings);
  const [editingId, setEditingId] = useState<string | null>(null);
  const isMac = useIsMac();

  const hotkeysByCategory = getHotkeysByCategory();
  const categories = Object.keys(hotkeysByCategory) as HotkeyCategory[];

  // The notice is a view of what the server holds, not a thing to keep in step
  // with it: any preference still stored in a shape that cannot fire.
  const resetHotkeys = unusablePreferences(preferences).map((p) => p.hotkeyId);

  // Name the shortcuts in the notice — "one shortcut" leaves the user hunting.
  const resetLabels = resetHotkeys
    .map((id) => HOTKEY_REGISTRY.find((h) => h.id === id)?.label ?? id)
    .map((label) => `"${label}"`)
    .join(', ');

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
      if (RESERVED_BINDINGS.has(binding)) {
        toast.warning(
          `${formatBindingForDisplay(binding, isMac)} is usually claimed by your browser, so this shortcut may never reach PageSpace`
        );
      } else {
        toast.success('Hotkey updated');
      }
      // Fold the saved binding into the cached payload rather than waiting for
      // the revalidation: the notice is derived from that payload, so until it
      // updates the banner keeps telling the user to set a shortcut they have
      // just set. Revalidation still follows and remains the source of truth.
      void mutate(
        (current) => ({
          preferences: [
            ...(current?.preferences ?? []).filter((p) => p.hotkeyId !== hotkeyId),
            { hotkeyId, binding },
          ],
        }),
        { revalidate: true }
      ).catch(() => {});
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update hotkey');
    }
  };

  // The rows are what make the notice survive a reload, so acknowledging it is
  // what deletes them — and with the notice derived, deleting them is the only
  // thing dismissing has to do.
  //
  // Which rows to delete comes from a fresh read rather than what this tab is
  // rendering: SWR does not revalidate on focus, so a tab left open on this
  // page never learns that another tab re-bound the shortcut, and deleting
  // from a stale list would throw away the binding the user had just set.
  const handleDismissResetNotice = async () => {
    try {
      const unusable = unusablePreferences(await fetchHotkeyPreferences());
      await Promise.all(unusable.map(({ hotkeyId }) => deleteHotkeyPreference(hotkeyId)));

      // Past this point the dismiss has succeeded. Drop the deleted rows from
      // the cached payload so the banner goes now, and keep the revalidation
      // out of the try — a refetch that fails afterwards must not report a
      // completed dismiss as a failure and leave the banner standing.
      const deleted = new Set(unusable.map(({ hotkeyId }) => hotkeyId));
      void mutate(
        (current) => ({
          preferences: (current?.preferences ?? []).filter((p) => !deleted.has(p.hotkeyId)),
        }),
        { revalidate: true }
      ).catch(() => {});
    } catch {
      // The rows survived, so the notice is still true and still showing. Say
      // why, rather than leaving it looking like the button did nothing.
      toast.error('Could not dismiss the notice — please try again');
    }
  };

  const handleReset = async (hotkeyId: string) => {
    // Drop the override entirely rather than storing the default as a custom
    // binding — the default is resolved per platform at read time.
    try {
      await deleteHotkeyPreference(hotkeyId);
      setEditingId(null);
      toast.success('Hotkey reset to default');
      mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset hotkey');
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
        {resetHotkeys.length > 0 && (
          <div className="mt-3 flex items-start gap-3 rounded-md border bg-muted/50 px-3 py-2">
            <p className="flex-1 text-sm text-muted-foreground">
              {resetLabels} {resetHotkeys.length === 1 ? 'was' : 'were'} saved in a format that could
              never be triggered, so {resetHotkeys.length === 1 ? 'it has' : 'they have'} been restored
              to the default. Set {resetHotkeys.length === 1 ? 'it' : 'them'} again below.
            </p>
            <Button variant="ghost" size="sm" onClick={handleDismissResetNotice}>
              Dismiss
            </Button>
          </div>
        )}
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
                      const isEditing = editingId === hotkey.id;
                      const isCustomized = userBindings.has(hotkey.id);
                      const effectiveBinding = isCustomized
                        ? userBindings.get(hotkey.id)!
                        : resolvePlatformBinding(hotkey.defaultBinding, isMac);

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
                                  {formatBindingForDisplay(effectiveBinding, isMac) || 'Disabled'}
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
