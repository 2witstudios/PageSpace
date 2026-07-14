/**
 * Shared AI hooks - used by both Agent engine and Global Assistant engine
 */

export { useMCPTools } from './useMCPTools';
export { useConversations } from './useConversations';
export { useConversationIdentity } from './useConversationIdentity';
export type { ConversationIdentityResolveResult } from './useConversationIdentity';
export { useMessageActions } from './useMessageActions';
export { useProviderSettings } from './useProviderSettings';
export { useChatTransport } from './useChatTransport';
export { useStreamingRegistration } from './useStreamingRegistration';
export { useChatStop } from './useChatStop';
export { useSendHandoff } from './useSendHandoff';
export { useStreamRecovery } from './useStreamRecovery';
export { useAskUserAnswering } from './useAskUserAnswering';

// Pure functions (no hooks, no side effects)
export {
  GLOBAL_CHAT_ID,
  AGENT_CHAT_ID,
  SIDEBAR_AGENT_CHAT_ID,
  buildChatConfig,
} from '../chat-config';
export { buildGlobalChatRequestBody } from '../global-chat-request-body';
