/**
 * The audio-native voice UI.
 *
 * Kept in its own directory beside the legacy `../` components (VoiceCallPanel
 * and friends, which drive the Whisper -> text -> TTS path) because both exist
 * at once for now: the old path still backs Read Aloud and is not retired until
 * chunk C-E. Two directories is how a reader tells which era a component
 * belongs to without reading it.
 */
export { VoiceNavTrigger, type VoiceNavTriggerProps } from './VoiceNavTrigger';
export { VoiceCallBar, type VoiceCallBarProps } from './VoiceCallBar';
export {
  VoiceCallBarForConversation,
  type VoiceCallBarForConversationProps,
} from './VoiceCallBarForConversation';
export { VoiceSessionBridge } from './VoiceSessionBridge';
