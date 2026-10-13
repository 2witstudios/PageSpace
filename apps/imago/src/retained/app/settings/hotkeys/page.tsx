"use client";

import { useState } from 'react';
import { RotateCcw, Search } from 'lucide-react';
import { Button } from '@/retained/components/ui/button';
import {
  useHotkeyPreferences,
  updateHotkeyPreference,
  deleteHotkeyPreference,
  fetchHotkeyPreferences,
  unusablePreferences,
} from '@/retained/hooks/useHotkeyPreferences';
import { HOTKEY_REGISTRY, HOTKEY_CATEGORIES, getHotkeysByCategory, type HotkeyCategory } from '@/retained/lib/hotkeys/registry';
import { getEffectiveBinding, resolvePlatformBinding, useHotkeyStore } from '@/retained/stores/useHotkeyStore';
import { HotkeyInput } from '@/retained/components/settings/hotkeys/HotkeyInput';
import { RESERVED_BINDINGS, formatBindingForDisplay } from '@/retained/lib/hotkeys/binding';
import { useIsMac } from '@/retained/hooks/useIsMac';
import { toast } from 'sonner';
import { SettingsGroup, SettingsRow, SettingsScreen, SettingsSection } from '@/ui/settings/settings-screen/settings-screen';
import { matchesHotkeyFilter } from './hotkey-filter';

export default function HotkeysSettingsPage() {
  const { preferences, isLoading, mutate } = useHotkeyPreferences();
  const userBindings = useHotkeyStore((s) => s.userBindings);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const isMac = useIsMac();

  const hotkeysByCategory = getHotkeysByCategory();
  const categories = Object.keys(hotkeysByCategory) as HotkeyCategory[];
  const visibleCategories = categories
    .map((category) => ({
      category,
      hotkeys: hotkeysByCategory[category].filter((hotkey) => matchesHotkeyFilter(hotkey, filter)),
    }))
    .filter(({ hotkeys }) => hotkeys.length > 0);

  // The notice is a view of what the server holds, not a thing to keep in step
  // with it: any preference still stored in a shape that cannot fire.
  const resetHotkeyIds = unusablePreferences(preferences).map((p) => p.hotkeyId);

  // Name the shortcuts in the notice — "one shortcut" leaves the user hunting.
  const resetLabels = resetHotkeyIds
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
      // Each delete is conditional on the binding this read saw. Between the
      // read and the delete another tab can save a real shortcut, and deleting
      // unconditionally would throw it away — the read narrows that window but
      // cannot close it.
      const unusable = unusablePreferences(await fetchHotkeyPreferences());
      const outcomes = await Promise.all(
        unusable.map(async ({ hotkeyId, binding }) => ({
          hotkeyId,
          removed: await deleteHotkeyPreference(hotkeyId, binding),
        }))
      );

      // Past this point the dismiss has succeeded. Fold the rows that actually
      // went out of the cached payload so the banner goes now — only those,
      // because a conditional delete that matched nothing means the row holds
      // something newer than this read saw, and hiding it would blank a
      // shortcut that is alive and well.
      //
      // The revalidation is deliberately not awaited: a refetch failing
      // afterwards must not report a completed dismiss as a failure. It is the
      // `void` and the `.catch` that guarantee that, not where the call sits —
      // awaiting it would put the rejection back into the catch below.
      const deleted = new Set(outcomes.filter((o) => o.removed).map((o) => o.hotkeyId));
      void mutate(
        (current) => ({
          preferences: (current?.preferences ?? []).filter((p) => !deleted.has(p.hotkeyId)),
        }),
        { revalidate: true }
      ).catch(() => {});
    } catch {
      // Say why, rather than leaving it looking like the button did nothing.
      toast.error('Could not dismiss the notice — please try again');

      // `Promise.all` fails fast, so some rows may already be gone while
      // others are not, and the fold above never ran. Refetch rather than
      // leave the banner naming shortcuts that no longer exist.
      void mutate().catch(() => {});
    }
  };

  const handleReset = async (hotkeyId: string) => {
    // Drop the override entirely rather than storing the default as a custom
    // binding — the default is resolved per platform at read time.
    try {
      await deleteHotkeyPreference(hotkeyId);
      setEditingId(null);
      toast.success('Hotkey reset to default');
      void mutate().catch(() => {});
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset hotkey');
    }
  };

  // Every customised binding goes back to its default, one conditional-free delete
  // each (the same delete the per-row reset uses). Reset all is only offered while
  // something is customised, so an empty map is a no-op rather than an error.
  const handleResetAll = async () => {
    const customisedIds = [...userBindings.keys()];
    if (customisedIds.length === 0) return;
    try {
      await Promise.all(customisedIds.map((hotkeyId) => deleteHotkeyPreference(hotkeyId)));
      setEditingId(null);
      toast.success('All shortcuts reset to default');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset shortcuts');
    } finally {
      void mutate().catch(() => {});
    }
  };

  return (
    <SettingsScreen
      title="Keyboard shortcuts"
      lede="Click a shortcut, then press the new keys. Synced to your account."
      actions={
        <Button variant="outline" size="sm" onClick={handleResetAll} disabled={userBindings.size === 0}>
          Reset all
        </Button>
      }
    >
      {resetHotkeyIds.length > 0 && (
        <div className="flex items-start gap-3 rounded-md border bg-muted/50 px-3 py-2">
          <p className="flex-1 text-sm text-muted-foreground">
            {resetLabels} {resetHotkeyIds.length === 1 ? 'was' : 'were'} saved in a format that could
            never be triggered, so {resetHotkeyIds.length === 1 ? 'it has' : 'they have'} been restored
            to the default. Set {resetHotkeyIds.length === 1 ? 'it' : 'them'} again below.
          </p>
          <Button variant="ghost" size="sm" onClick={handleDismissResetNotice}>
            Dismiss
          </Button>
        </div>
      )}

      <label className="flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-muted-foreground">
        <Search className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        <input
          aria-label="Filter shortcuts"
          placeholder="Filter shortcuts"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
        />
      </label>

      {isLoading ? (
        <div className="text-muted-foreground">Loading...</div>
      ) : (
        visibleCategories.map(({ category, hotkeys }) => {
          const categoryInfo = HOTKEY_CATEGORIES[category];

          return (
            <SettingsSection key={category} title={categoryInfo.label} description={categoryInfo.description}>
              <SettingsGroup label={categoryInfo.label}>
                {hotkeys.map((hotkey) => {
                  const isEditing = editingId === hotkey.id;
                  const isCustomized = userBindings.has(hotkey.id);
                  const defaultBinding = resolvePlatformBinding(hotkey.defaultBinding, isMac);
                  const effectiveBinding = isCustomized
                    ? userBindings.get(hotkey.id)!
                    : defaultBinding;
                  const defaultLabel = formatBindingForDisplay(defaultBinding, isMac) || 'Disabled';

                  return (
                    <SettingsRow key={hotkey.id} label={hotkey.label} hint={hotkey.description}>
                      {isEditing ? (
                        <HotkeyInput
                          initialValue={effectiveBinding}
                          onSave={(binding) => handleSave(hotkey.id, binding)}
                          onCancel={() => setEditingId(null)}
                        />
                      ) : (
                        <>
                          {isCustomized && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleReset(hotkey.id)}
                              title={`Reset to ${defaultLabel}`}
                              className="h-7 px-2 text-primary"
                            >
                              <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                              Reset to {defaultLabel}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditingId(hotkey.id)}
                            aria-label={`Change shortcut for ${hotkey.label}`}
                            className={
                              isCustomized
                                ? 'min-w-[120px] border-primary bg-primary/5 font-mono text-primary'
                                : 'min-w-[120px] font-mono'
                            }
                          >
                            {formatBindingForDisplay(effectiveBinding, isMac) || 'Disabled'}
                          </Button>
                        </>
                      )}
                    </SettingsRow>
                  );
                })}
              </SettingsGroup>
            </SettingsSection>
          );
        })
      )}
      {!isLoading && visibleCategories.length === 0 && (
        <p className="text-sm text-muted-foreground">No shortcuts match &ldquo;{filter}&rdquo;.</p>
      )}
    </SettingsScreen>
  );
}
