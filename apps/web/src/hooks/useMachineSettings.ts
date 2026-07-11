'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { fetchWithAuth, patch as apiPatch } from '@/lib/auth/auth-fetch';
import type {
  MachineSettings,
  MachineSettingsPatch,
} from '@pagespace/lib/services/machines/machine-settings';

/**
 * The Machine Settings state machine, behind `/api/machines/settings`.
 *
 * Deliberately NOT SWR (unlike its `useMachineProjects` / `useMachineBranches`
 * siblings): the Settings tab is specified to follow `TerminalAccessCard`'s
 * plain `useState`/`useEffect` + optimistic-`persist` shape. What SWR would have
 * given us for free — revalidation — is the reason most of the machinery below
 * exists, so it is spelled out explicitly here rather than left implicit in the
 * view.
 *
 * The whole point of extracting this is that the failure path is where all the
 * subtlety lives, and none of it is about rendering:
 *
 *  - Text fields are DRAFTS, committed on blur; toggles persist immediately. Both
 *    can therefore be in flight AT ONCE, so every rule below is written for
 *    concurrent saves, not a single one.
 *  - A failed save reverts ONLY the keys it owned. Reverting a whole snapshot
 *    would roll back an unrelated edit that succeeded while it was in flight.
 *  - A failed save then RESYNCS, because the local snapshot is only a guess at
 *    server truth (a request can commit and then time out, leaving the tab
 *    permanently stale with nothing to revalidate it). The resync is deferred
 *    until every save has drained: a GET fired while another PATCH is airborne
 *    reads pre-PATCH state and is then overwritten by it — recreating exactly the
 *    staleness it exists to fix.
 *  - A resync adopts server values only for drafts the user has NOT touched,
 *    so it can't delete text mid-keystroke.
 *  - Results for a machine we have since navigated away from are dropped, rather
 *    than written onto the machine now on screen.
 */
export interface UseMachineSettings {
  settings: MachineSettings | null;
  /** True only while we have nothing to show for this machine (first load / retry). */
  loading: boolean;
  /** Count, not a flag — a blur-commit and a toggle can be saving together. */
  pendingSaves: number;
  nameDraft: string;
  setNameDraft: (value: string) => void;
  descriptionDraft: string;
  setDescriptionDraft: (value: string) => void;
  /** Blur handlers: normalize, skip a no-op, and persist. */
  commitName: () => void;
  commitDescription: () => void;
  /** Persist an access toggle immediately. */
  setAccess: (patch: MachineSettingsPatch) => void;
  reload: () => void;
}

export function useMachineSettings(machineId: string): UseMachineSettings {
  const [settings, setSettings] = useState<MachineSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const [pendingSaves, setPendingSaves] = useState(0);
  // Mirrored into a ref because `persist`'s `finally` must read the CURRENT count,
  // not the one closed over when it started.
  const pendingSavesRef = useRef(0);
  const resyncWhenIdle = useRef(false);

  const [nameDraft, setNameDraft] = useState('');
  const [descriptionDraft, setDescriptionDraft] = useState('');

  // Last known SERVER value — lets a resync tell a clean draft from a dirty one.
  const serverSettings = useRef<MachineSettings | null>(null);
  // Which machine we currently hold settings for.
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const isNewMachine = loadedFor.current !== machineId;
    if (isNewMachine) {
      // Drop the previous machine's settings before loading a different one —
      // otherwise a FAILED load would fall through to rendering the old machine's
      // name/toggles under the new machine's identity. A resync owed to the machine
      // we're leaving is dropped with it, so it can't fire a spurious refetch once
      // an unrelated save on the NEW machine drains.
      setSettings(null);
      serverSettings.current = null;
      resyncWhenIdle.current = false;
    }
    // Spinner whenever we have nothing to show for THIS machine. `serverSettings`
    // moves in exact lockstep with `settings`, so the ref answers that without
    // reading state — doing it via a `setSettings` updater instead would be an
    // IMPURE UPDATER, which StrictMode replays at render time (after the load's
    // `finally` already cleared `loading`), stranding the tab on a spinner forever.
    if (isNewMachine || serverSettings.current === null) setLoading(true);

    (async () => {
      try {
        const response = await fetchWithAuth(
          `/api/machines/settings?machineId=${encodeURIComponent(machineId)}`,
        );
        if (!response.ok) throw new Error('Failed to load machine settings');
        const json = (await response.json()) as { settings: MachineSettings };
        if (cancelled) return;
        const next = json.settings;
        const previousServer = serverSettings.current;
        loadedFor.current = machineId;
        serverSettings.current = next;
        setSettings(next);
        // Adopt the server value only for drafts the user has NOT touched since we
        // last saw the server: a resync fires while the tab is open and in use.
        setNameDraft((draft) =>
          previousServer === null || draft === previousServer.name ? next.name : draft,
        );
        setDescriptionDraft((draft) =>
          previousServer === null || draft === (previousServer.description ?? '')
            ? next.description ?? ''
            : draft,
        );
      } catch (error) {
        console.error('Failed to load machine settings:', error);
        // A failed RESYNC keeps the form (and its already-good settings) on screen —
        // only a failed FIRST load leaves `settings` null for the error state.
        if (!cancelled) toast.error('Failed to load machine settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [machineId, reloadToken]);

  /**
   * Optimistically apply `patch`, PATCH it, and on failure revert + resync.
   *
   * We do NOT reconcile from the PATCH response body. The route echoes the whole
   * `MachineSettings`, so applying it would clobber a field the user is
   * concurrently editing with a value that was already stale when the request
   * left. Every field we send is normalized client-side exactly as the route
   * normalizes it (name trimmed; blank description → null), so on success the
   * optimistic value already equals the persisted one.
   */
  async function persist(patch: MachineSettingsPatch) {
    if (!settings) return;
    const revert: MachineSettingsPatch = {};
    for (const key of Object.keys(patch) as (keyof MachineSettingsPatch)[]) {
      Object.assign(revert, { [key]: settings[key] });
    }

    // If the tab is showing a DIFFERENT machine by the time this settles, every
    // write below would land on that machine's form — reverting machine A's name
    // into machine B's input, where the next blur would rename B.
    const forMachine = machineId;
    const isStale = () => loadedFor.current !== forMachine;

    setSettings((current) => (current ? { ...current, ...patch } : current));
    pendingSavesRef.current += 1;
    setPendingSaves(pendingSavesRef.current);
    try {
      await apiPatch('/api/machines/settings', { machineId: forMachine, ...patch });
    } catch (error) {
      if (isStale()) return;
      setSettings((current) => (current ? { ...current, ...revert } : current));
      if (revert.name !== undefined) setNameDraft(revert.name);
      if (revert.description !== undefined) setDescriptionDraft(revert.description ?? '');
      resyncWhenIdle.current = true;
      toast.error(error instanceof Error ? error.message : 'Failed to update machine settings');
    } finally {
      pendingSavesRef.current -= 1;
      setPendingSaves(pendingSavesRef.current);
      if (!isStale() && pendingSavesRef.current === 0 && resyncWhenIdle.current) {
        resyncWhenIdle.current = false;
        setReloadToken((t) => t + 1);
      }
    }
  }

  function commitName() {
    if (!settings) return;
    const trimmed = nameDraft.trim();
    // An empty name is rejected server-side (it IS the page title). Revert the
    // draft rather than firing a doomed PATCH.
    if (trimmed.length === 0) {
      setNameDraft(settings.name);
      return;
    }
    setNameDraft(trimmed);
    if (trimmed === settings.name) return;
    persist({ name: trimmed });
  }

  function commitDescription() {
    if (!settings) return;
    const trimmed = descriptionDraft.trim();
    setDescriptionDraft(trimmed);
    if (trimmed === (settings.description ?? '')) return;
    // Whitespace-only clears the description (round-trips to null server-side).
    persist({ description: trimmed.length === 0 ? null : trimmed });
  }

  return {
    settings,
    loading,
    pendingSaves,
    nameDraft,
    setNameDraft,
    descriptionDraft,
    setDescriptionDraft,
    commitName,
    commitDescription,
    setAccess: persist,
    reload: () => setReloadToken((t) => t + 1),
  };
}
