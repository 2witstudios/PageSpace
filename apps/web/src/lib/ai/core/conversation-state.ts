/**
 * Cookie-based conversation state management
 * Simple and works everywhere - dashboard, sidebar, across navigation
 */

import { getCookieValue } from '@/lib/utils/get-cookie-value';
import { createId } from '@paralleldrive/cuid2';

/**
 * Pure function: classify a conversation GET response status for loadConversation.
 * 404 = conversation not yet persisted (lazy creation) → treat as empty, not an error.
 */
export function classifyConversationLoadResponse(status: number): 'ok' | 'not-found' | 'error' {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404) return 'not-found';
  return 'error';
}

const ACTIVE_CONVERSATION_COOKIE = 'activeConversationId';
const ACTIVE_AGENT_COOKIE = 'activeAgentId';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * Client-side utilities for conversation state
 */
export const conversationState = {
  /**
   * Get the active conversation ID from cookies (client-side)
   */
  getActiveConversationId(): string | null {
    return getCookieValue(ACTIVE_CONVERSATION_COOKIE);
  },

  /**
   * Set the active conversation ID in cookies (client-side)
   */
  setActiveConversationId(conversationId: string | null) {
    if (typeof document === 'undefined') return;

    try {
      if (conversationId) {
        const maxAge = COOKIE_MAX_AGE;
        const secure = window.location.protocol === 'https:';
        const encodedValue = encodeURIComponent(conversationId);
        document.cookie = `${ACTIVE_CONVERSATION_COOKIE}=${encodedValue}; max-age=${maxAge}; path=/; ${secure ? 'secure;' : ''} samesite=lax`;
      } else {
        document.cookie = `${ACTIVE_CONVERSATION_COOKIE}=; max-age=0; path=/`;
      }
    } catch (error) {
      console.error('Error setting active conversation ID:', error);
    }
  },

  /**
   * Create a new conversation ID locally and set it as active.
   * No backend call — the conversation row is created on the first message POST.
   * The useChat({ id }) prop is a React state key only; it does not require a DB record.
   * Source: useChatTransport.ts (DefaultChatTransport routes to api URL, not id prop).
   */
  async createAndSetActiveConversation(options: {
    title?: string;
    type?: 'global' | 'page' | 'drive';
    contextId?: string;
  } = {}) {
    const id = createId();
    this.setActiveConversationId(id);
    return {
      id,
      type: options.type ?? 'global',
      title: null,
      lastMessageAt: null,
      createdAt: new Date().toISOString(),
    };
  },

  /**
   * Start a new conversation
   */
  async startNewConversation() {
    const conversation = await this.createAndSetActiveConversation();
    return conversation;
  },

  /**
   * Get the active agent ID from cookies (client-side)
   */
  getActiveAgentId(): string | null {
    return getCookieValue(ACTIVE_AGENT_COOKIE);
  },

  /**
   * Set the active agent ID in cookies (client-side)
   * Pass null to clear the agent (switches to Global Assistant)
   */
  setActiveAgentId(agentId: string | null) {
    if (typeof document === 'undefined') return;

    try {
      if (agentId) {
        const maxAge = COOKIE_MAX_AGE;
        const secure = window.location.protocol === 'https:';
        const encodedValue = encodeURIComponent(agentId);
        document.cookie = `${ACTIVE_AGENT_COOKIE}=${encodedValue}; max-age=${maxAge}; path=/; ${secure ? 'secure;' : ''} samesite=lax`;
      } else {
        document.cookie = `${ACTIVE_AGENT_COOKIE}=; max-age=0; path=/`;
      }
    } catch (error) {
      console.error('Error setting active agent ID:', error);
    }
  },

  /**
   * Clear the active agent (switch to Global Assistant)
   */
  clearActiveAgent() {
    this.setActiveAgentId(null);
  },
};