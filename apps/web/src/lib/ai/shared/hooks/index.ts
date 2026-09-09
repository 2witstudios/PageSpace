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
export { useStreamingRegistration } from './useStreamingRegistration';
export { useSendHandoff } from './useSendHandoff';
export { useResumeBootstrap } from './useResumeBootstrap';
export { useAnswerAskUser } from './useAnswerAskUser';
export { useChatErrorCause } from './useChatErrorCause';

export { useChatSession } from './useChatSession';
export type { ChatSessionStatus, UseChatSessionResult } from './useChatSession';

// Pure functions (no hooks, no side effects)
export { buildGlobalChatRequestBody } from '../global-chat-request-body';
