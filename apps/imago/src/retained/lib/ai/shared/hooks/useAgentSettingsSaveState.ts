/**
 * useAgentSettingsSaveState - the Agent Settings Save button's
 * clean/dirty/saving/saved state machine.
 *
 * Shared by the two hosts that render their OWN Save button around a
 * `PageAgentSettingsTab` instance — `AgentPageView`'s full page header and
 * `AgentPanes`' compact per-pane bar. Both wire the returned setters into
 * `PageAgentSettingsTab`'s `onSavingChange`/`onDirtyChange`/`onSaved` props.
 *
 * - clean: nothing to save (also forced whenever `isConfigLoaded` is
 *   false — `PageAgentSettingsTab` registers `submitForm` before its own
 *   config-loaded check returns, with EMPTY prompt/tool list defaults, so
 *   the button must stay inert until real config has loaded AND been
 *   edited; review finding — chatgpt-codex-connector on PR #2299).
 * - dirty: unsaved edits, the only state the button is clickable in.
 * - saving: a submit is in flight.
 * - saved: a brief (`SAVED_CONFIRMATION_MS`) confirmation window after a
 *   successful save, replacing the success toast that used to cover the
 *   Chat/History/Settings tabs and other header buttons.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type AgentSettingsSaveState = 'clean' | 'dirty' | 'saving' | 'saved';

const SAVED_CONFIRMATION_MS = 1800;

interface UseAgentSettingsSaveStateOptions {
  /** Defaults to true — pass false while the agent config is still loading. */
  isConfigLoaded?: boolean;
}

export function useAgentSettingsSaveState({ isConfigLoaded = true }: UseAgentSettingsSaveStateOptions = {}) {
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSaved = useCallback(() => {
    if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
    setJustSaved(true);
    savedTimeoutRef.current = setTimeout(() => setJustSaved(false), SAVED_CONFIRMATION_MS);
  }, []);

  useEffect(() => () => {
    if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
  }, []);

  const saveState: AgentSettingsSaveState = !isConfigLoaded
    ? 'clean'
    : isSaving
    ? 'saving'
    : isDirty
    ? 'dirty'
    : justSaved
    ? 'saved'
    : 'clean';

  return { saveState, isSaving, setIsSaving, setIsDirty, handleSaved };
}
