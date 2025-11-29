/**
 * Cookie-based conversation state management
 * Simple and works everywhere - dashboard, sidebar, across navigation
 */

import { post } from '@/lib/auth/auth-fetch';
import { getCookieValue } from '@/lib/utils/get-cookie-value';

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
   * Create a new conversation and set it as active
   */
  async createAndSetActiveConversation(options: {
    title?: string;
    type?: 'global' | 'page' | 'drive';
    contextId?: string;
  } = {}) {
    try {
      const conversation = await post<{
        id: string;
        title: string;
        type: string;
        lastMessageAt: string;
        createdAt: string;
      }>('/api/ai/global', {
        title: options.title,
        type: options.type || 'global',
        contextId: options.contextId,
      });

      this.setActiveConversationId(conversation.id);
      return conversation;
    } catch (error) {
      console.error('Error creating conversation:', error);
      throw error;
    }
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