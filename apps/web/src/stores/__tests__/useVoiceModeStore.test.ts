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

  describe('loadSettings', () => {
    it('defaults to conversation mode when nothing is stored', () => {
      useVoiceModeStore.getState().loadSettings();
      expect(useVoiceModeStore.getState().interactionMode).toBe('conversation');
    });

    it('migrates legacy barge-in value to conversation and persists it', () => {
      localStorage.setItem('pagespace:voice:interactionMode', 'barge-in');
      useVoiceModeStore.getState().loadSettings();
      expect(useVoiceModeStore.getState().interactionMode).toBe('conversation');
      expect(localStorage.getItem('pagespace:voice:interactionMode')).toBe('conversation');
    });

    it('preserves tap-to-speak when stored', () => {
      localStorage.setItem('pagespace:voice:interactionMode', 'tap-to-speak');
      useVoiceModeStore.getState().loadSettings();
      expect(useVoiceModeStore.getState().interactionMode).toBe('tap-to-speak');
    });

    it('preserves conversation when already stored as conversation', () => {
      localStorage.setItem('pagespace:voice:interactionMode', 'conversation');
      useVoiceModeStore.getState().loadSettings();
      expect(useVoiceModeStore.getState().interactionMode).toBe('conversation');
    });
  });
});
