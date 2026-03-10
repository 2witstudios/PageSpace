/**
 * Shared AI hooks - used by both Agent engine and Global Assistant engine
 */

export { useMCPTools } from './useMCPTools';
export { useConversations } from './useConversations';
export { useMessageActions } from './useMessageActions';
export { useProviderSettings } from './useProviderSettings';
export { useChatTransport } from './useChatTransport';
export { useStreamingRegistration } from './useStreamingRegistration';
export { useChatStop } from './useChatStop';
export { useSendHandoff } from './useSendHandoff';
export { useStreamRecovery } from './useStreamRecovery';
export { useVoiceModeChat } from './useVoiceModeChat';
export type { VoiceModeChatOptions, LastAIResponse, UseVoiceModeChatReturn } from './useVoiceModeChat';
export { useChatError } from './useChatError';
export type { UseChatErrorOptions, UseChatErrorReturn } from './useChatError';
export { useImageAttachments } from './useImageAttachments';
export type { ImageAttachment } from './useImageAttachments';
