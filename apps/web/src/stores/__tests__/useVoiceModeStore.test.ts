import { describe, it, expect, beforeEach } from 'vitest';
import { useVoiceModeStore } from '../useVoiceModeStore';

describe('useVoiceModeStore', () => {
  beforeEach(() => {
    useVoiceModeStore.setState({
      isEnabled: false,
      owner: null,
      voiceState: 'idle',
      hasLoadedSettings: true,
      interactionMode: 'tap-to-speak',
      ttsVoice: 'nova',
      ttsSpeed: 1,
      autoSend: true,
      currentTranscript: '',
      error: null,
      currentAudioId: null,
    });
    window.localStorage.clear();
  });

  it('sets owner when enabling voice mode', () => {
    useVoiceModeStore.getState().enable('global-assistant');

    const state = useVoiceModeStore.getState();
    expect(state.isEnabled).toBe(true);
    expect(state.owner).toBe('global-assistant');
    expect(state.voiceState).toBe('idle');
  });

  it('transfers ownership and resets active session state', () => {
    useVoiceModeStore.getState().enable('global-assistant');
    useVoiceModeStore.getState().setVoiceState('speaking');
    useVoiceModeStore.getState().setCurrentTranscript('existing transcript');
    useVoiceModeStore.getState().setCurrentAudioId('audio-123');

    useVoiceModeStore.getState().enable('sidebar-chat');

    const state = useVoiceModeStore.getState();
    expect(state.isEnabled).toBe(true);
    expect(state.owner).toBe('sidebar-chat');
    expect(state.voiceState).toBe('idle');
    expect(state.currentTranscript).toBe('');
    expect(state.currentAudioId).toBeNull();
  });

  it('clears owner when disabling voice mode', () => {
    useVoiceModeStore.getState().enable('ai-page');
    useVoiceModeStore.getState().disable();

    const state = useVoiceModeStore.getState();
    expect(state.isEnabled).toBe(false);
    expect(state.owner).toBeNull();
    expect(state.voiceState).toBe('idle');
  });
});
