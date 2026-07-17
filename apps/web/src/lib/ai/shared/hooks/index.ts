/**
 * Shared AI hooks - used by both Agent engine and Global Assistant engine
 */

export { useMCPTools } from './useMCPTools';
export { useConversations } from './useConversations';
export { useConversationIdentity } from './useConversationIdentity';
export type { ConversationIdentityResolveResult } from './useConversationIdentity';
export { useMessageActions } from './useMessageActions';
export { useCacheMessageActions } from './useCacheMessageActions';
export { useProviderSettings } from './useProviderSettings';
export { useChatTransport } from './useChatTransport';
export { useStreamingRegistration } from './useStreamingRegistration';
export { useSendHandoff } from './useSendHandoff';
export { useResumeBootstrap } from './useResumeBootstrap';
export { useAnswerAskUser } from './useAnswerAskUser';

// Pure functions (no hooks, no side effects)
export {
  GLOBAL_CHAT_ID,
  AGENT_CHAT_ID,
  SIDEBAR_AGENT_CHAT_ID,
  buildChatConfig,
} from '../chat-config';
export { buildGlobalChatRequestBody } from '../global-chat-request-body';
