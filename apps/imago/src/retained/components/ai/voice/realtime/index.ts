/**
 * The audio-native voice UI — now the only voice UI. The legacy `../`
 * components that drove the STT -> text -> TTS loop are gone; this directory
 * kept its name because the distinction it marked is settled, not because a
 * second era still exists.
 */
export { VoiceNavTrigger, type VoiceNavTriggerProps } from './VoiceNavTrigger';
export { VoiceCallBar, type VoiceCallBarProps } from './VoiceCallBar';
export {
  VoiceCallBarForConversation,
  type VoiceCallBarForConversationProps,
} from './VoiceCallBarForConversation';
export { VoiceSessionBridge } from './VoiceSessionBridge';
